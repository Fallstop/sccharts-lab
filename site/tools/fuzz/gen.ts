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
    /** The timed annotations and ode actions (KIELER's TimedAutomata and ODE processors): @Logical / @Passive on the
     *  clock's declaration or variable, in any case, @NoSleep, @DeviationOutput, @IntegerClockType, @SimulateSleep, a
     *  chart's own `lag`, and `ode` actions on a float and an int. Implies clocks. Not in `mix`. */
    | 'timed'
    /** Written schedules: `schedule {conflicting, commuting} s` declarations and `schedule s N` clauses on
     *  writes of w in concurrent regions (absolute writes too, which only the schedule orders), on calls, inside
     *  method bodies and code blocks, the contracts of a class's methods and the schedule of its instance, a chart used
     *  as a class with a schedule. Not in `mix`. */
    | 'schedules'
    /** Nested instances: a struct inside a struct (`ln.a.qx`), a class inside a class (`box.in.v`, a method of the
     *  inner one), an array of class instances with a method (`cells[1].inc()`, `cells[n % 2].v`), an array member of
     *  an array of structs (`rows[n % 2].arr[1]`), and methods with a loop, which KIELER keeps as functions and whose
     *  accesses it reads through their own `self` (`cells[0].bump()`, `cells[1].put(n)`, `box.fill()`). Not in `mix`. */
    | 'nested'
    /** Generic parameters (structure.md S-73): referenced charts with value, type and chart parameters given literals,
     *  variables, types and charts; `ref C<..> g(...)` instances; a base chart with a parameter (`extends GB<3>`), also
     *  with bindings; inner states that extend a generic chart; `region Q is R`; now and then a form KIELER rejects (a
     *  missing or wrong argument, a parameter handed on in `is C<N>`, a written literal parameter) and a nested chart
     *  whose local has an enclosing parameter's name. Not in `mix`. */
    | 'generics'

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
    // A template of its own (reincarnationChart): states with abort regions entered again in the tick they finish.
    reincarnation: { features: [...BASE, 'abortRegions', 'actions'] },
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
    // Nested structs and classes, and arrays of instances, read and written in triggers, effects and methods.
    nested: { features: [...BASE, 'nested', 'actions'], optional: ['structs', 'classes', 'code', 'signals', 'count', 'references'], optionalRate: 0.3 },
    // Written schedules ordering concurrent writes of w, in two or three regions.
    schedules: { features: ['hierarchy', 'concurrency', 'data', 'immediate', 'joins', 'schedules'], optional: ['actions', 'signals', 'aborts', 'references'], optionalRate: 0.3, roots: [2, 2, 3], maxDepth: 1 },
    // A template of its own (randomChart): random() and randomize() wherever KIELER's C code can call them.
    random: { features: [...BASE, 'classes'] },
    // A template of its own (dataflowObjectsChart): dataflow regions with chart instances, calls and schedules.
    dataflowObjects: { features: [...BASE, 'dataflow', 'classes', 'schedules'] },
    // Generic charts among ordinary behaviour: references, declared instances, extends, inner extends, region references.
    // (Aborts and immediate transitions only now and then: most charts should reach the tick-by-tick comparison.)
    generics: { features: ['hierarchy', 'concurrency', 'data', 'joins', 'generics', 'references'], optional: ['aborts', 'immediate', 'signals', 'actions', 'count', 'pre', 'forRegions', 'locals', 'connectors'], optionalRate: 0.2, weights: { reference: 2, immediate: 0.5 }, maxDepth: 1 },
    // Timed annotations and ode actions among clocks, suspension and references.
    timed: { features: ['hierarchy', 'data', 'immediate', 'joins', 'clocks', 'timed', 'actions'], optional: ['concurrency', 'aborts', 'count', 'suspend', 'references', 'signals', 'history'], optionalRate: 0.25, maxDepth: 1 },
    // A template of its own (pointersChart): arrays named without their indices, C's pointers in KIELER's code.
    pointers: { features: [...BASE, 'classes'] },
}

/** Clock declarations of the timed profile: @Logical / @Passive count on the declaration (any case), not on the variable. */
const TIMED_CLOCKS = [
    '  clock t = 0', '  @Logical clock t = 0', '  @logical clock t = 0', '  clock @Logical t = 0', '  @Passive clock t = 0',
    '  @Passive @Logical clock t = 0', '  clock @Passive t = 0', '  @Logical clock t = 0',
]

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
    /** Nested instances in scope: ln (struct in struct), box (class in class), cells[2] (instance array). */
    nested?: boolean
    /** A written schedule object in scope (writes of w carry `schedule <sched> N`). */
    sched?: string
    /** `ode` targets in scope (the chart's f and g; a referenced chart has none). */
    ode?: string[]
    /** Rare forms: a method reading `state(R0.R0s1)`, a chart with constants (`scchart(FK).K`), a primed constant. */
    rare?: { at?: string; konst?: string; prime?: string }
    /** The simulated chart of the `generics` profile (inner states may extend a generic chart there). */
    genericRoot?: boolean
}

class Generator {
    private readonly on: (f: Feature) => boolean
    private readonly w: (k: keyof NonNullable<Profile['weights']>) => number
    private children: string[] = []
    private priority = 0
    /** The `schedules` profile declared the class `Tk` with contract methods (instance `tk`), and a region that calls them all. */
    private contracts = false
    private contractRegion = false
    /** The `schedules` profile declared `ref SK<n> rk`, a chart used as a class with a schedule `q` and contracts. */
    private refClass = false
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
        if (s.nested) opts.push('ln.a.qx > 1', 'ln.b.qx == ln.wd', 'box.in.get() > 1', 'cells[0].v > 1', 'cells[1].v == 2', 'cells[n % 2].v > 0', 'cells[0].sum(1) > 2', 'rows[0].arr[1] > 1', 'rows[n % 2].arr[0] == 1')
        // An element with a variable index before or after a plain variable (KIELER's partial evaluation loses the
        // index in the first case, sim/guardIndices.ts): of an array of instances, of a member array, of a method.
        // Now and then only: gcc rejects the lost index of an array of instances, and most charts should run.
        if (s.nested && s.bools.length && r.chance(0.12)) {
            const p = r.pick(s.bools)
            opts.push(`${p} && cells[n % 2].v > 0`, `rows[1].arr[n % 2] == 0 && ${p}`, 'cells[n % 2].v == cells[1].v', r.pick([`cells[n % 2].v > 0 && ${p}`, `rows[n % 2].arr[1] == 0 || ${p}`, `cells[n % 2].sum(1) > 2 && ${p}`, 'cells[n % 2].v > n']))
        }
        if (s.rare?.at) opts.push(`${s.rare.at}()`, `!${s.rare.at}()`, `a && ${s.rare.at}()`)
        if (s.rare?.konst) opts.push(`scchart(${s.rare.konst}).ON && b`, `n > scchart(${s.rare.konst}).K`)
        if (s.rare?.prime) opts.push(`n == ${s.rare.prime}`)
        if (this.on('polish') && s.bools.length > 1) {
            const [p, q] = [r.pick(s.bools), r.pick(s.bools)]
            opts.push(`(${p}) ? ${q}`, `${q} && ((${p}) ? (!${q}))`, `pre(n, ${p}) > 1`, `pre(n) == pre(n, ${q})`, `ov[n % 3] > 0`)
            // An element before a plain variable loses its index in KIELER's C code (sim/guardIndices.ts).
            opts.push(`ov[n % 2] > 0 && ${p}`, `ov[n % 2] > n`, `ov[n % 2] < n`, `!(ov[n % 2] > n) || ${q}`, `ov[ov[n % 2] % 2] > 0 && ${p}`, `${p} && ov[n % 2] > 0`, `ov[n % 2] > 0 && pre(${q})`)
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
            if (s.nested) {
                opts.push('ln.a.qx += 1', 'box.in.inc()', 'box.w += 1', 'cells[0].inc()', 'cells[1].v += 1', 'cells[n % 2].inc()')
                opts.push('cells[0].bump()', 'cells[1].bump()', 'cells[n % 2].bump()', 'box.fill()', 'rows[0].arr[1] += 1', 'rows[n % 2].arr[n % 2] += 1', 'rows[0].arr[n % 2] += 1', 'rows[n % 2].arr[1] += 1')
                // Absolute writes in concurrent regions too, now and then: KIELER compares them by identifier and by method.
                if (s.conc && r.chance(0.3)) opts.push('cells[0].put(1)', 'cells[1].put(n)', 'cells[n % 2].v = 0', 'cells[0].v = 3', 'rows[0].arr[n % 2] = 1', 'rows[n % 2].arr[1] = 2', 'rows[0].arr[1] = 2', 'box.in.v = 8', 'box.w = cells[0].sum(n)', 'box.w = cells[0].sum(1)')
                if (!s.conc || r.chance(0.2)) opts.push('ln.b = ln.a', 'ln.a = ln.b', 'cells[1].k += cells[0].k')
                if (!s.conc) opts.push('cells[0].put(n)', 'rows[1].arr[0] = rows[0].arr[1]', 'box.w = cells[1].sum(2)', 'ln.b.qx = ln.a.qx + 1', 'ln.wd = n', 'box.w = box.in.get()', 'cells[1].v = cells[0].v + 1', 'cells[n % 2].v = 0')
            }
            if (s.sched) {
                // Absolute and relative writes of w, ordered (or not) by the schedule's priorities.
                // Mostly a priority of its own (a total order KIELER accepts), now and then a shared one.
                const k = r.chance(0.65) ? this.priority++ : r.int(0, 2)
                opts.push(...[`w = ${r.pick(['1', '2', 'w + 1', 'n'].filter(v => v !== 'n' || s.ints.length))} schedule ${s.sched} ${k}`, `w += 1 schedule ${s.sched} ${k}`, `w = w * 2 schedule ${s.sched} ${k}`].flatMap(x => [x, x]))
                // Clauses on calls (a short method, one with a single argument, which loses the clause, and a C
                // function, whose body it does not reach), inside a method body and in code blocks (S-27a).
                const own = () => (r.chance(0.65) ? this.priority++ : r.int(0, 2))
                opts.push(
                    `setW(${r.pick(['1', '2'])}, 0) schedule ${s.sched} ${own()}`,
                    `{ w = 3 schedule ${s.sched} ${k}; }`, `{ if n > 1 schedule ${s.sched} ${k} { w += 1 schedule ${s.sched} ${k}; } }`,
                    `{ for (int j = 0; j < 2; j++) { w += 1 schedule ${s.sched} ${k}; } }`)
                // (These three write w outside the schedule's order, so they mostly conflict with a concurrent write.)
                if (r.chance(0.25)) opts.push(r.pick([`setW1(2) schedule ${s.sched} ${own()}`, `loopW(1, 0) schedule ${s.sched} ${own()}`, 'inW()']))
                // Contract methods of a class and the instance's own schedule.
                if (this.contracts && (!s.conc || r.chance(0.25))) {
                    opts.push('tk.put(2)', 'tk.add()', `tk.v = 2 schedule tk.q ${r.int(0, 2)}`)
                    if (!s.conc) opts.push(`w = 1 schedule tk.q ${k}`)
                    if (s.outs.length) opts.push(`${r.pick(s.outs)} = tk.get()`)
                    // A contract method in an argument of a C function that is a local variable's initial value.
                    if (!s.conc && s.outs.length && r.chance(0.3)) opts.push(`{ int k2 = idLoop(tk.get(), 0); ${r.pick(s.outs)} = k2; }`)
                }
                if (this.refClass && (!s.conc || r.chance(0.25))) {
                    opts.push('rk.put(2)', `w = 1 schedule rk.q ${r.int(0, 2)}`)
                    if (s.outs.length) opts.push(`${r.pick(s.outs)} = rk.get()`)
                }
                // Methods reached through other methods, and a condition that is a call of a C function.
                if (r.chance(0.2)) opts.push(r.pick(['viaW()', 'loopVia()', `{ if isWLoop() schedule ${s.sched} ${k} { w += 1 schedule ${s.sched} ${k}; } }`]))
                // A clause naming a variable that is no schedule: nothing to order on a constant print.
                if (r.chance(0.1)) opts.push('print("p") schedule nsq 0')
                // Refused by KIELER, rarely: the cast on an assignment, a scheduled condition that is a short method's
                // call, a schedule read as a value.
                if (r.chance(0.03)) opts.push(r.pick(['w = 1 schedule nsq 0', `{ if isW() schedule ${s.sched} ${k} { w += 1 schedule ${s.sched} ${k}; } }`, `w = ${s.sched}`]))
            }
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
            if (sup && s.genericRoot && r.chance(0.12)) {
                // The superstate extends a generic chart and binds its output (the chart's own gz).
                this.helper('GI', 'scchart GI<M is int> {\n  output int gout = 0\n  region GIR {\n    initial state GIs0\n    if gout < 20 do gout += M go to GIs0\n  }\n}')
                out.push(`${head} extends GI<${r.pick(['1', '2', '3', 'n'])}>(gz) {`, ...body, `${pad}}`)
            } else if (body.length) out.push(`${head} {`, ...body, `${pad}}`)
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
        if (s.ode?.length && r.chance(superstate ? 0.3 : 0.15)) {
            // One Euler step per tick: f += e * deltaT (g, an int, is truncated as C does).
            out.push(`${pad}ode ${r.pick([...s.ode, s.ode[0]])} = ${r.pick(['1', '2', '-1', 'n', 'n + 1', '0.5'])}`)
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

    /** The generic charts made so far: name and parameter kinds. */
    private genericChildren: { name: string; params: ('int' | 'bool' | 'prim' | 'chart')[] }[] = []
    private helpers = new Set<string>()

    /** Adds a fixed helper chart of the `generics` profile once. */
    private helper(name: string, text: string) {
        if (this.helpers.has(name)) return
        this.helpers.add(name)
        this.children.push(text)
    }

    /**
     * A generic chart to reference (`G0<2, int>(a, b, x)`); returns the call. Its body uses the value parameters in
     * triggers and effects, declares a variable of the primitive type parameter, and makes a state an instance of
     * the chart type parameter.
     */
    genericReference(s: Scope): string {
        const r = this.rng
        if (!this.genericChildren.length || (this.genericChildren.length < 3 && r.chance(0.5))) {
            const name = `G${this.genericChildren.length}`
            const params: ('int' | 'bool' | 'prim' | 'chart')[] = [r.pick(['int', 'int', 'int', 'bool', 'prim', 'chart'] as const)]
            if (r.chance(0.4)) params.push(r.pick((['int', 'bool', 'prim'] as const).filter(k => k !== 'prim' || !params.includes('prim'))))
            const names = params.map((k, i) => (k === 'int' ? `N${i}` : k === 'bool' ? `B${i}` : k === 'prim' ? 'T' : 'W'))
            const header = params.map((k, i) => `${names[i]} is ${k === 'int' ? 'int' : k === 'bool' ? 'bool' : k === 'prim' ? 'primitive' : 'GW0'}`).join(', ')
            const sub = new Generator(r, new Set([...this.features].filter(f => f !== 'references' && f !== 'forRegions' && f !== 'dataflow' && f !== 'generics')), { features: [] })
            const scope: Scope = {
                conc: true, depth: 1, bools: ['p', 'q', ...names.filter((_, i) => params[i] === 'bool')], ints: names.filter((_, i) => params[i] === 'int'),
                outs: ['o', ...(params.includes('prim') ? ['tv'] : [])], signals: this.on('signals') ? ['T0'] : [], valued: [],
            }
            const lines = [`scchart ${name}<${header}> {`, '  input bool p, q', '  output int o = 0', ...(scope.signals.length ? ['  output signal T0'] : [])]
            if (params.includes('prim')) lines.push(`  primitive T tv = ${r.pick(['1', '2', '0'])}`)
            const chart = params.includes('chart')
            const body = sub.region(scope, '    ', `${name}x`)
            lines.push('  region {', ...body.lines, '  }')
            // The parameters at work, in regions of their own (commuting updates of the output only).
            if (scope.ints.length && r.chance(0.7)) {
                const n = r.pick(scope.ints)
                lines.push('  region {', `    initial state ${name}u`, r.pick([`    if p do o += ${n} go to ${name}u`, `    if ${n} > 1 do o += 1 go to ${name}u`, `    do o += ${n} + 1 go to ${name}u`]), '  }')
            }
            const flag = names.find((_, i) => params[i] === 'bool')
            if (flag && r.chance(0.7)) lines.push('  region {', `    initial state ${name}b`, `    if ${flag} do o += 1 go to ${name}b`, '  }')
            if (params.includes('prim') && r.chance(0.7)) {
                lines.push('  region {', `    initial state ${name}t`, `    do tv += 1 go to ${name}tt`, `    state ${name}tt`, `    if tv > 2 do o += 1 go to ${name}t`, `    go to ${name}t`, '  }')
            }
            // The chart given for W, as an instance: its output is the chart's.
            if (chart) lines.push('  region {', `    initial state ${name}w is W(o)`, '  }')
            if (scope.ints.length && r.chance(0.12)) {
                // A chart that is not generic, with a local of the parameter's name at its top (KIELER takes it for the parameter).
                const local = scope.ints[0]
                this.helper(`GCAP${local}`, `scchart GCAP${local} {\n  output int o = 0\n  int ${local} = 5\n  initial state GCs0\n  if ${local} < 9 do o += ${local}; ${local} += 1 go to GCs0\n}`)
                lines.push('  region {', `    initial state ${name}c is GCAP${local}(o)`, '  }')
            }
            const target = this.genericChildren.find(g => g.params.length === 1 && g.params[0] === 'int')
            if (scope.ints.length && target && r.chance(0.04)) {
                // The parameter handed on in generic arguments: KIELER does not replace it there.
                lines.push('  region {', `    initial state ${name}f is ${target.name}<${scope.ints[0]}>(p, q, o${scope.signals.length ? ', T0' : ''})`, '  }')
            }
            // Now and then the chart writes its value parameter: a crash when it stands for a literal.
            if (scope.ints.length && r.chance(0.05)) lines.push(`  region {`, `    initial state ${name}v`, `    if p do ${scope.ints[0]} += 1 go to ${name}v`, '  }')
            lines.push('}')
            this.children.push(lines.join('\n'))
            this.genericChildren.push({ name, params })
            if (chart) {
                this.helper('GW0', 'scchart GW0 {\n  output int o = 0\n  initial state GWs0\n  do o += 1 go to GWs0\n}')
                this.helper('GW1', 'scchart GW1 extends GW0 {\n  region GW1R {\n    initial state GWs1\n    do o += 2 go to GWs1\n  }\n}')
            }
        }
        const child = r.pick(this.genericChildren)
        const args = child.params.map(k => {
            // A wrong or unusable argument now and then (both tools must reject it).
            if (r.chance(0.012)) return r.pick(['"txt"', 'true', '1.5', 'int', 'q9'])
            switch (k) {
                case 'int': return r.pick(['1', '2', '3', '2', 'n', 'n', ...(this.on('forRegions') ? ['arr[1]'] : []), ...(s.conc ? [] : [r.pick(s.outs)]), 'KG'])
                case 'bool': return r.pick(['true', 'false', r.pick(s.bools.filter(b => !/^B\d/.test(b)))])
                case 'prim': return r.pick(['int', 'int', 'float'])
                default: return r.pick(['GW0', 'GW1', 'GW1'])
            }
        })
        const [p, q] = [r.pick(s.bools), r.pick(s.bools)]
        const o = r.pick(s.outs.length ? s.outs : ['x'])
        const sig = this.on('signals') ? `, ${r.pick(s.signals.length ? s.signals : ['S'])}` : ''
        const generics = r.chance(0.012) ? '' : `<${args.join(', ')}>`
        return `${child.name}${generics}(${p}, ${q}, ${o}${sig})`
    }

    /** A generated chart to reference (`C0(a, b, x)`); returns the call. */
    reference(s: Scope): string {
        const r = this.rng
        if (this.on('generics') && r.chance(0.75)) return this.genericReference(s)
        if (!this.childNames.length || (this.childNames.length < 2 && r.chance(0.4))) {
            const name = `C${this.childNames.length}`
            this.childNames.push(name)
            const sub = new Generator(r, new Set([...this.features].filter(f => f !== 'references' && f !== 'forRegions' && f !== 'dataflow')), { features: [] })
            // Its output is bound to a variable the referencing chart may update concurrently: commuting updates only.
            const scope: Scope = { conc: true, depth: 1, bools: ['p', 'q'], ints: [], outs: ['o'], signals: this.on('signals') ? ['T'] : [], valued: [] }
            const lines = [`scchart ${name} {`, '  input bool p, q', '  output int o = 0', ...(scope.signals.length ? ['  output signal T'] : [])]
            // A clock of the copy: its annotations must survive the copying (declaration only, any case).
            if (this.on('timed') && r.chance(0.6)) {
                if (r.chance(0.3)) lines.unshift(r.pick(['@DeviationOutput', '@deviationoutput', '@NoSleep']))
                lines.push(r.pick(TIMED_CLOCKS).replace(' t = 0', ' cc = 0'))
                scope.clock = 'cc'
                scope.sharedClock = true
            }
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
        if (this.on('timed') && r.chance(0.2)) {
            // A base chart with its own clock and annotations: KIELER's Inheritance copies both into this chart.
            lines[0] = `scchart F${index} extends FB${index} {`
            const ann = r.chance(0.5) ? [r.pick(['@DeviationOutput', '@deviationoutput', '@NoSleep', '@IntegerClockType'])] : []
            this.children.push([...ann, `scchart FB${index} {`, r.pick(TIMED_CLOCKS).replace(' t = 0', ' bc = 0'), '  region {', '    initial state FBs0',
                `    if bc >= ${r.pick([100, 300])} go to FBs1`, '    state FBs1', '    if bc >= 600 do bc = 0 go to FBs0', '  }', '}'].join('\n'))
        }
        // The `generics` profile: a base chart with a value parameter, with or without bindings.
        let base: 'plain' | 'bound' | undefined
        if (this.on('generics')) {
            lines.push('  const int KG = 2', '  output int gx = 0, gy = 0, gz = 0')
            if (r.chance(0.3)) {
                base = r.chance(0.7) ? 'plain' : 'bound'
                const arg = r.pick(['1', '2', '3', 'n', 'KG'])
                // (A wrong argument, or a parameter list that leaves the output open, now and then.)
                lines[0] = base === 'plain'
                    ? `scchart F${index} extends GB<${r.chance(0.04) ? 'true' : arg}> {`
                    : `scchart F${index} extends GBB<${arg}>(${r.chance(0.08) ? 'a' : r.chance(0.06) ? 'a, gy, gz' : 'a, gy'}) {`
                if (base === 'plain') {
                    // Now and then a method whose body declares the parameter's name again (in a loop, in a block:
                    // the parameter is the argument again afterwards) or takes it as a local's initial value (rejected).
                    const scoping = r.pick(['none', 'none', 'none', 'for', 'block', 'init'])
                    const method = scoping === 'for' ? ['  method int gm() { int s = 0 for (int M = 0; M < 2; M++) { s += 1 } return s + M }']
                        : scoping === 'block' ? ['  method int gm() { int s = 0 { int M = 7 s = M } return s + M }']
                        : scoping === 'init' ? ['  method int gm() { int s = M return s }'] : []
                    const bound = scoping === 'none' ? 'M' : 'gm()'
                    this.helper('GB', ['scchart GB<M is int> {', '  output int gb = 0, gq = 0', ...method, '  region GBR {', '    initial state GBs0', `    if gb < ${bound} + ${r.pick([2, 5])} do gb += M go to GBs0`,
                        '    if gb > 20 go to GBs1', '    state GBs1', '    do gb = 0 go to GBs0', '  }',
                        '  region GBQ {', '    initial state GBq0', '    if gb > 3 do gq += 1 go to GBq0', '  }', '}'].join('\n'))
                } else {
                    this.helper('GBB', ['scchart GBB<M is int> {', '  input bool gp', '  output int gout = 0', '  region GBR {', '    initial state GBs0', '    if gp do gout += M go to GBs0',
                        '    if gout > 20 go to GBs1', '    state GBs1', '  }', '}'].join('\n'))
                }
            }
        }
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
        if (this.on('timed')) {
            // Chart annotations in random case; KIELER compares their names ignoring case.
            const variants: Record<string, string[]> = {
                NoSleep: ['@NoSleep', '@nosleep'], DeviationOutput: ['@DeviationOutput', '@deviationOutput'],
                IntegerClockType: ['@IntegerClockType', '@IntegralClockType'], SimulateSleep: ['@SimulateSleep'],
            }
            const rates: Record<string, number> = { NoSleep: 0.15, DeviationOutput: 0.35, IntegerClockType: 0.25, SimulateSleep: 0.15 }
            for (const [k, v] of Object.entries(variants)) if (r.chance(rates[k])) lines.unshift(r.pick(v))
            lines.push('  output float f = 0', '  output int g = 0')
            if (r.chance(0.12)) lines.push('  output int lag = 0')
            // @Logical / @Passive on the declaration count; on the variable (clock @Logical t) KIELER ignores them.
            lines.push(r.pick(TIMED_CLOCKS))
        } else if (this.on('clocks')) lines.push('  clock t = 0')
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
        if (this.on('schedules')) {
            const protocols = Array.from({ length: r.int(0, 3) }, () => r.pick(['conflicting', 'commuting', 'conflicting']))
            const decl = r.chance(0.15) ? `"sch" global ${r.pick(['conflicting', 'commuting'])} ` : protocols.length ? `{${protocols.join(', ')}} ` : ''
            lines.push(`  schedule ${decl}s`, '  output int w = 0')
            lines.push(
                '  method void setW(int a, int b) {', '    w = a + b', '  }',
                '  method void setW1(int a) {', '    w = a', '  }',
                '  method void loopW(int a, int b) {', '    for (int j = 0; j < 2; j++) {', '      w = a + b;', '    }', '  }',
                '  method void inW() {', `    w += 1 schedule s ${r.int(0, 3)}`, '  }')
            // A class whose methods have contracts (priorities of the class's schedule), sometimes a C function.
            this.contracts = r.chance(0.6)
            if (this.contracts) {
                // Mostly commuting priorities (two concurrent calls of one method are then fine) and a priority per method.
                const list = r.chance(0.6) ? '{commuting, commuting, commuting} ' : r.chance(0.5) ? `{${Array.from({ length: r.int(1, 3) }, () => r.pick(['conflicting', 'commuting'])).join(', ')}} ` : ''
                const add = r.chance(0.3) ? ['      for (int j = 0; j < 1; j++) {', '        v += 1;', '      }'] : ['      v += 1']
                // (put 0, add 1, get 2 is the order the writes and reads of v have anyway.)
                const order = r.chance(0.5) ? [0, 2, 1] : r.chance(0.6) ? r.pick([[0, 1, 2], [1, 0, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) : [r.int(0, 2), r.int(0, 2), r.int(0, 2)]
                lines.push(
                    '  class Tk {', `    schedule ${list}q`, '    int v = 0',
                    `    void put(int a) schedule q ${order[0]} {`, '      v = a', '    }',
                    `    int get() schedule q ${order[1]} {`, '      return v', '    }',
                    `    void add() schedule q ${order[2]} {`, ...add, '    }', '  } tk')
                // Every contract method has to be called somewhere: mostly a region of its own does.
                this.contractRegion = r.chance(0.92)
            }
            // Forms a review found missing: methods reached through other methods, a variable that is no schedule, a
            // scheduled condition that is a call, C functions for a local variable's initial value.
            lines.push(
                '  int nsq = 0',
                '  method void viaW() {', '    inW()', '  }',
                '  method void loopVia() {', '    for (int j = 0; j < 1; j++) {', '      inW();', '    }', '  }',
                '  method bool isW() {', '    return w > 0', '  }',
                '  method bool isWLoop() {', '    bool q2 = false', '    for (int j = 0; j < 1; j++) {', '      q2 = w > 0;', '    }', '    return q2', '  }',
                '  method int idLoop(int a, int b) {', '    int q3 = 0', '    for (int j = 0; j < 1; j++) {', '      q3 = a + b;', '    }', '    return q3', '  }')
            // A chart used as a class: its schedule is the instance's (`schedule rk.q N`), its contracts order the
            // calls; now and then what KIELER refuses (a class's schedule named without the instance in a method, a
            // schedule one class further in, an array of instances, the schedule read as a value).
            this.refClass = r.chance(0.4)
            if (this.refClass) {
                const bad = r.chance(0.15) ? r.pick(['bare', 'nested', 'array', 'sibling', 'value']) : undefined
                const order = r.chance(0.6) ? [0, 1] : [r.int(0, 2), r.int(0, 2)]
                lines.push(`  ref SK${index} rk${bad === 'array' ? '[2]' : ''}`)
                if (bad === 'array') this.refClass = false
                this.children.push([
                    `scchart SK${index} {`, '  schedule {commuting, commuting, commuting} q', '  int v = 0',
                    `  method void put(int a) schedule q ${order[0]} {`, `    v = a${bad === 'bare' ? ' schedule q 0' : ''}`, '  }',
                    `  method int get() schedule q ${order[1]} {`, `    return ${bad === 'value' ? 'v + q' : 'v'}`, '  }',
                    ...(bad === 'sibling' ? ['  method void both() {', '    put(1)', '  }'] : []),
                    ...(bad === 'nested' ? ['  class In {', '    schedule t', '    int u = 0', '  } in'] : []),
                    // (Clauses naming its own schedule are fine in its regions: KIELER moves them into the declaring chart.)
                    ...(r.chance(0.3) ? ['  region {', '    initial state SKa', `    do v += 1 schedule q ${r.int(0, 2)} go to SKb`, '    state SKb', '  }'] : []),
                    '}'].join('\n'))
            }
        }
        if (this.on('nested')) {
            lines.push(
                '  struct Line {', '    struct P2 {', '      int qx = 0', '    } a, b', '    int wd = 1', '  } ln',
                '  class Box {', '    class In {', '      int v = 0', '      void inc() {', '        v = v + 1', '      }', '      int get() {', '        return v', '      }', '    } in', '    int w = 0',
                '    void fill() {', '      for (int j = 0; j < 2; j++) {', '        in.v += 1;', '      }', '    }', '  } box',
                '  class Cell {', '    int v = 0', '    int k = v + 2', '    void inc() {', '      v = v + 1', '    }',
                '    void bump() {', '      for (int j = 0; j < 2; j++) {', '        v += 1;', '      }', '    }',
                '    void put(int a) {', '      for (int j = 0; j < 1; j++) {', '        v = a;', '      }', '    }',
                '    int sum(int a) {', '      int r = 0', '      for (int j = 0; j < 2; j++) {', '        r = r + v + a;', '      }', '      return r', '    }', '  } cells[2]',
                '  struct Row {', '    int arr[2]', '  } rows[2]')
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
            rare: this.on('rare') ? rare : undefined, ode: this.on('timed') ? ['f', 'g'] : undefined, sched: this.on('schedules') ? 's' : undefined, nested: this.on('nested') || undefined,
            genericRoot: this.on('generics') || undefined,
        }
        if (this.on('generics')) {
            // Instances declared with `ref`, bound to an output of their own; the base chart's output is read here.
            if (r.chance(0.35)) {
                const call = this.genericReference({ ...scope, conc: true, outs: ['gx'] })
                const at = call.indexOf('(')
                const head = call.slice(0, at)
                const lt = head.indexOf('<')
                // The generic arguments after the chart or after the variable.
                lines.push(lt < 0 ? `  ref ${head} gi${call.slice(at)}` : r.chance(0.5) ? `  ref ${head} gi${call.slice(at)}` : `  ref ${head.slice(0, lt)} gi${head.slice(lt)}${call.slice(at)}`)
            }
            if (base === 'plain') scope.ints.push('gb')
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
        if (this.contracts && this.contractRegion) {
            lines.push('  region RK {', '    initial state K0', '    do tk.put(n) go to K1', '    state K1', '    do z = tk.get() go to K2', '    state K2', '    do tk.add() go to K0', '  }')
        }
        if (this.refClass) lines.push('  region RS {', '    initial state S0', '    do rk.put(n) go to S1', '    state S1', '    do y = rk.get() go to S0', '  }')
        // A copy of the inherited region next to it.
        // (GBR names the base chart's parameter, which a copy cannot bind: rejected, now and then.)
        if (base === 'plain' && r.chance(0.3)) lines.push(`  region RQ is ${r.chance(0.1) ? 'GBR' : 'GBQ'}`)
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
/**
 * The `reincarnation` profile's chart: a state with abort regions that is entered again in the tick it finishes (its
 * own `join to`, with or without an effect or `deferred`, through a second state, or as the inside of a state that
 * restarts), with delayed regions so that KIELER accepts the restart. Varied: leading and trailing abort regions,
 * one that never ends, self-loops and entry actions inside the regions (KIELER makes the resuming and the restarting
 * side two nodes, which both run), a second content region, a superstate inside, a signal between the regions.
 */
function reincarnationChart(r: Rng, index: number): string {
    const signal = r.chance(0.3)
    const lines = [`scchart F${index} {`, '  input bool a, b, c, d', '  input int n', '  output int x = 0, y = 0, z = 0, entries = 0', ...(signal ? ['  signal S'] : [])]
    const trigger = () => r.pick(['a', 'b', 'c', 'd', 'a', 'b', 'n > 1', 'c && d', ...(signal ? ['S'] : [])])
    const effect = () => r.pick(['x += 1', 'y += 1', 'z += 1', 'x += 1; y += 1', ...(signal ? ['S', 'x += 1; S'] : [])])
    const act = (rate: number) => (r.chance(rate) ? `do ${effect()} ` : '')
    const state = (pad: string, name: string, kind = '') => (r.chance(0.3) ? [`${pad}${kind}state ${name} {`, `${pad}  entry do ${effect()}`, `${pad}}`] : [`${pad}${kind}state ${name}`])
    const region = (pad: string, prefix: string, abort: boolean, end: boolean): string[] => {
        const out = [`${pad}${abort ? 'abort region' : 'region'} ${prefix} {`, ...state(`${pad}  `, `${prefix}I`, 'initial ')]
        if (r.chance(0.35)) out.push(`${pad}  if ${trigger()} ${act(0.5)}go to ${prefix}I`)
        if (r.chance(0.3)) {
            out.push(`${pad}  if ${trigger()} ${act(0.4)}go to ${prefix}J`, ...state(`${pad}  `, `${prefix}J`))
            out.push(`${pad}  if ${trigger()} ${act(0.3)}go to ${r.pick([`${prefix}I`, end ? `${prefix}F` : `${prefix}I`])}`)
        }
        if (end) {
            // Now and then the transition into the final state is on the second state only.
            out.push(`${pad}  if ${trigger()} ${act(0.4)}go to ${prefix}F`, `${pad}  final state ${prefix}F`)
        }
        out.push(`${pad}}`)
        return out
    }
    const restarting = (pad: string, name: string, kind: string): string[] => {
        const out = [`${pad}${kind}state ${name} {`]
        if (r.chance(0.55)) out.push(`${pad}  entry do entries += 1`)
        const leading = r.chance(0.6)
        const trailing = !leading || r.chance(0.5)
        if (leading) out.push(...region(`${pad}  `, `${name}L`, true, !r.chance(0.12)))
        out.push(...region(`${pad}  `, `${name}C`, false, !r.chance(0.1)))
        if (r.chance(0.3)) out.push(...region(`${pad}  `, `${name}D`, false, true))
        if (trailing) out.push(...region(`${pad}  `, `${name}T`, true, !r.chance(0.12)))
        out.push(`${pad}}`)
        return out
    }
    const shape = r.pick(['self', 'self', 'self', 'effect', 'deferred', 'through', 'outer', 'delayed'])
    if (shape === 'outer') {
        // The restarting state is the inside of a state whose own join enters it again.
        lines.push('  initial state O {', ...restarting('    ', 'M', 'initial '), `    join to ${r.pick(['K', 'M'])}`, '    final state K', '  }', '  join to O')
    } else {
        lines.push(...restarting('  ', 'M', 'initial '))
        if (shape === 'self') lines.push('  join to M')
        else if (shape === 'effect') lines.push(`  do ${effect()} join to M`)
        else if (shape === 'deferred') lines.push('  join to M deferred')
        else if (shape === 'through') lines.push('  join to N', '  state N', `  immediate ${act(0.5)}go to M`)
        else lines.push('  join to N', '  state N', `  if ${trigger()} go to M`)
    }
    lines.push('}')
    return lines.join('\n') + '\n'
}

/**
 * The `dataflowObjects` profile's chart: dataflow regions that KIELER translates in its OO way (an equation calls a
 * method) and in its classic way, next to a control-flow region that reads their outputs. Drawn from: chart
 * instances wired by equations (`g.p = ...`, `g = {e, _}`, `o1 = g.r`) of a gate chart with a dataflow region or
 * states of its own (initial values, a local, now and then a final state), declared in the chart, in the region or
 * in a state, singly, as two of one declaration or as an array; a chart used as a class and a class instance, called
 * in equations (`k.add(n)`, `k.add(1) = a`, `o2 = k.get()`, `cells[n % 2].add(1)`); the chart's own methods; vectors
 * assigned to arrays; sequences with `;`; `dataflow once` in a state entered late; schedules on equations and on
 * regions against a transition's scheduled write; an explicit binding; a transition that writes an instance's input.
 * Now and then what KIELER rejects: an instance shared by a classic and an OO region, a schedule clause the classic
 * translation loses, a positional binding too many. A third region now and then: an array or an instance's array port
 * indexed by an instance's output or a call, a `dataflow for` region, a vector after a call equation.
 */
function dataflowObjectsChart(r: Rng, index: number): string {
    const lines = [`scchart F${index} {`, '  input bool a, b, c, d', '  input int n', '  output int x = 0, y = 0, z = 0', '  output int o1 = 0, o2 = 0, o3 = 0, o4 = 0', '  output int arr[3] = {0, 0, 0}']
    const children: string[] = []
    const sched = r.chance(0.3)
    if (sched) lines.push(`  schedule ${r.chance(0.3) ? '{conflicting, commuting} ' : ''}s`, '  output int w = 0')
    // The gate chart: p, q in, r out.
    const gateKind = r.pick(['dataflow', 'dataflow', 'states', 'counter', 'final'])
    const gate = [`scchart G${index} {`, `  input int p${r.chance(0.2) ? ' = 2' : ''}, q`, `  output int r${r.chance(0.2) ? ' = 5' : ''}`]
    if (gateKind === 'dataflow') gate.push(`  dataflow { r = ${r.pick(['p + q + 1', 'p * 2 + q', 'p - q', 'pre(p) + q'])} }`)
    else if (gateKind === 'states') gate.push('  initial state GA', '  if p > 1 do r = p + q go to GB', '  state GB', '  do r += 1 go to GA')
    else if (gateKind === 'counter') gate.push('  int k = 3', '  initial state GA', '  do k += 1; r = p + k go to GA')
    else gate.push('  initial state GA', '  do r = p go to GB', '  state GB', '  if q > 0 do r = p + 100 go to GC', '  final state GC')
    gate.push('}')
    children.push(gate.join('\n'))
    // A chart used as a class.
    const withRegion = r.chance(0.3)
    children.push([`scchart K${index} {`, '  int v = 0', '  method void add(int j) { v += j }', '  method int get() { return v }',
        ...(withRegion ? ['  int t = 0', '  region KT { initial state KA do t += 1 go to KA }'] : []), '}'].join('\n'))
    lines.push('  method int twice(int j) { return j * 2 }')
    const cells = r.chance(0.3)
    lines.push(`  class Acc { int v = 0  void add(int j) { v += j }  int get() { return v } } acc${cells ? ', cells[2]' : ''}`)

    // Instances: where they are declared and how.
    const gateDecl = r.pick(['one', 'one', 'one', 'two', 'array', 'bound', 'explicit'])
    const gateRef = gateDecl === 'two' ? `ref G${index} g, g2` : gateDecl === 'array' ? `ref G${index} gs[2]`
        : gateDecl === 'bound' ? `ref G${index} g(${r.chance(0.15) ? 'n, n, o4, n' : 'n'})` : gateDecl === 'explicit' ? `ref G${index} g(n to q)` : `ref G${index} g`
    const g = gateDecl === 'array' ? 'gs[0]' : 'g'
    const g2 = gateDecl === 'array' ? 'gs[1]' : gateDecl === 'two' ? 'g2' : undefined
    const inRegion = r.chance(0.25)
    const counterRef = r.chance(0.25) ? `ref K${index} k, k2` : `ref K${index} k`
    if (!inRegion) lines.push(`  ${gateRef}`)
    lines.push(`  ${counterRef}`)

    const src = () => r.pick(['n', 'n + 1', 'n * 2', 'pre(n)', 'x', 'pre(x)', '(a ? 1 : 2)'])
    const call = () => r.pick(['twice(n)', 'twice(n) + 1', 'acc.get()', 'k.get()', 'k.get() + n', 'twice(x)'])
    // The equations of the instance's region.
    const oo = r.chance(0.7)
    const eqs: string[] = []
    const seq = oo && r.chance(0.2)
    if (gateDecl !== 'explicit' || r.chance(0.2)) {
        eqs.push(r.chance(0.2) ? `${g} = {${src()}, ${r.pick(['_', 'n', oo ? 'twice(n)' : 'n + 2'])}}` : `${g}.p = ${oo && r.chance(0.5) ? call() : src()}`)
    } else eqs.push(`${g}.p = ${src()}`)
    if (gateDecl !== 'explicit' && gateDecl !== 'bound' && r.chance(0.4)) eqs.push(`${g}.q = ${r.pick(['n', '1', 'pre(n)'])}`)
    if (g2) eqs.push(`${g2}.p = ${r.pick([`${g}.r`, 'n', `${g}.r + 1`])}`)
    eqs.push(`o1 = ${g2 && r.chance(0.6) ? `${g2}.r` : `${g}.r`}${r.chance(0.3) ? ' + 1' : ''}`)
    if (oo) {
        const calls = [`k.add(${r.pick(['n', '1', 'twice(n)'])})`, `k.add(1) = ${r.pick(['a', 'n > 1', 'b && !c'])}`, 'acc.add(n)', 'acc.add(1) = a']
        if (cells) calls.push('cells[n % 2].add(1)', 'cells[0].add(n)')
        if (counterRef.includes('k2')) calls.push('k2.add(n)')
        eqs.push(r.pick(calls))
        if (r.chance(0.5)) eqs.push(r.pick(calls))
        eqs.push(`o2 = ${r.pick(['k.get()', 'acc.get()', 'twice(n)', 'k.get() + 1', ...(cells ? ['cells[1].get()'] : []), ...(counterRef.includes('k2') ? ['k2.get()'] : [])])}`)
    } else if (r.chance(0.5)) eqs.push(`o2 = ${src()}`)
    if (r.chance(0.3)) eqs.push(`arr = {${src()}, ${r.pick(['_', '1', 'n'])}${r.chance(0.5) ? ', n' : ''}}`)
    // Schedule clauses: on an equation (kept by the OO translation only) against the transition's write of w.
    const eqSched = sched && r.chance(0.5)
    const regionSched = sched && !eqSched && r.chance(0.6)
    if (eqSched) eqs.push(`w = ${r.pick(['n', 'twice(n)', '5'])} schedule s ${r.pick([0, 1, 1])}`)
    if (regionSched) eqs.push(`w = ${oo ? 'twice(n)' : 'n + 1'}`)
    const shuffled = seq ? eqs : eqs.map(e => [r.next(), e] as const).sort((p, q) => p[0] - q[0]).map(e => e[1])
    const body = shuffled.map((e, i) => `    ${e}${seq && i < shuffled.length - 1 && r.chance(0.6) ? ';' : ''}`)
    const header = `  dataflow D1${regionSched ? ` schedule s ${r.pick([0, 1])}` : ''} {`
    const first = [header, ...(inRegion ? [`    ${gateRef}`] : []), ...body, '  }']

    // A second dataflow region: more calls, or (rarely) a second user of the instance.
    const second: string[] = []
    if (r.chance(0.5)) {
        const eq2: string[] = []
        const share = !inRegion && r.chance(0.15)
        if (share) eq2.push(`o3 = ${g}.r${r.chance(0.5) ? ' + twice(1)' : ''}`)
        else eq2.push(`o3 = ${r.pick(['twice(n) + o1', 'o1 + 1', 'acc.get() + 1', 'pre(o1)', 'k.get()'])}`)
        if (r.chance(0.4)) eq2.push(`o4 = ${r.pick(['o3 + 1', 'twice(o3)', 'n'])}`)
        second.push('  dataflow D2 {', ...eq2.map(e => `    ${e}`), '  }')
    }

    // Control flow beside it: reads the outputs, counts, sometimes writes an instance's input or the scheduled w.
    const trigger = () => r.pick(['a', 'b', 'c', 'n > 1', 'o1 > 2', 'o2 > 1', 'a && !b', 'pre(a)', ...(oo && !inRegion && gateDecl !== 'explicit' ? [`${g}.r > 1`] : [])])
    const effect = () => r.pick(['x += 1', 'y += 1', 'z += 1', 'x += 1; y += 1', 'z += o1', ...(sched ? [`w = 9 schedule s ${r.pick([0, 1, 2])}`] : []),
        ...(oo && !inRegion && gateDecl === 'one' && r.chance(0.3) ? [`${g}.q = n`] : [])])
    const control = ['  region R0 {', '    initial state A', `    if ${trigger()} do ${effect()} go to B`, ...(r.chance(0.4) ? [`    if ${trigger()} do ${effect()} go to A`] : []), '    state B']
    if (r.chance(0.35)) {
        // A state with a dataflow region of its own, entered late: `once` runs its equations at every entry.
        const once = r.chance(0.5)
        control.push(`    if ${trigger()} go to C`, `    ${r.pick(['', 'immediate '])}go to A`, '    state C {', `      dataflow${once ? ' once' : ''} {`,
            `        o4 = ${r.pick(['twice(n)', 'n + 1', 'acc.get() + n'])}`, '      }', '    }', `    if ${trigger()} ${r.pick(['go to', 'abort to'])} A`)
    } else control.push(`    if ${trigger()} do ${effect()} go to A`)
    control.push('  }')
    const regions = r.chance(0.5) ? [...first, ...second, ...control] : [...control, ...first, ...second]
    // (Both drawn last, so that the charts of earlier campaigns keep the rest of their shape.)
    const forms = instanceForms(r, index, counterRef.includes('k2'))
    // More forms two reviews found untested, in a third dataflow region: a port or
    // an array indexed by an instance's output or a call, in a member's index too (the classic translation makes one
    // variable of an array port and drops the index; a call nested in an assigned member's index is rejected); a
    // dataflow for-region with or without its counter in an equation; a vector after a call equation.
    const third: string[] = []
    const form = r.pick(['none', 'none', 'index', 'index', 'for', 'vector'])
    if (form !== 'none') lines.splice(5, 0, '  output int o5 = 0')
    if (form === 'index') {
        children.push(`scchart C${index} {\n  input int v[2]\n  output int w = 0\n  ${r.chance(0.25) ? 'initial state CA do w = v[1] go to CA' : 'initial state CA do w += 1 go to CA'}\n}`)
        lines.splice(6, 0, `  ref C${index} cell`, '  int ia[2] = {0, 1}')
        // (Every index stays inside its array: `ia` only ever holds 0 and 1, the inputs are not negative.)
        const index1 = r.pick(['n % 2', 'cell.w % 2', 'twice(n) % 2', 'twice(1) - 1', 'ia[n % 2]', 'ia[twice(1) - 2]', 'k.get() % 2'])
        const port = r.chance(0.65)
        const target = port ? `cell.v[${index1}]` : `ia[${index1}]`
        third.push('  dataflow D3 {', `    ${target} = ${port ? r.pick(['n', '7', 'twice(n)']) : r.pick(['0', '1', 'n % 2', 'twice(n) % 2'])}`,
            `    o5 = ${r.pick(['cell.v[1]', 'cell.v[0] + cell.w', `ia[${r.pick(['1', 'cell.w % 2', 'twice(1) - 1'])}]`])}`, '  }')
    } else if (form === 'for') {
        third.push(`  dataflow D3 for i : 0 to ${r.pick([1, 2])} {`, `    ${r.pick(['o5 += 1', 'o5 = twice(n)', 'acc.add(1)', 'o5 = n + i', 'arr[i] = twice(n)', 'o5 = n'])}`, '  }')
    } else if (form === 'vector') {
        third.push('  dataflow D3 {', `    ${r.pick(['acc.add(1) = {a}', 'k.add(n) = {true, false}', 'twice(n) = {a}'])}`, `    o5 = ${r.pick(['acc.get()', 'k.get()', 'twice(n)'])}`, '  }')
    }
    lines.push(...forms.decls, ...regions, ...third, ...forms.region, '}')
    return [lines.join('\n'), ...children, ...forms.children].join('\n\n') + '\n'
}

/**
 * What two reviews of the chart instances found the template never made: an array of instances whose fields start
 * from sibling fields (of two, one or three elements, with a class object or an instance inside), a vector spread
 * over the constant input of an array of instances (read by a method, a region, an initial value or a class inside
 * the chart; now and then a vector KIELER refuses), instances without fields (a short method, a C function, called or not, also inside another
 * instance, which KIELER cannot initialise when that one has no field either), the second instance of a declaration
 * used outside the dataflow region, a class that has the name KIELER would give an instance's class, a field whose
 * name starts with an underscore. A region RX reads them into `u`, one transition per form.
 */
function instanceForms(r: Rng, index: number, second: boolean): { decls: string[]; region: string[]; children: string[] } {
    const decls: string[] = []
    const children: string[] = []
    const terms: string[] = []
    if (r.chance(0.35)) {
        const size = r.pick([2, 2, 2, 1, 3])
        const inner = r.chance(0.3)
        const leaf = !inner && r.chance(0.3)
        children.push([`scchart QA${index} {`, `  int a = ${r.pick([4, 1])}`, `  int b = ${r.pick(['a + 2', 'a + 2', 'a * 2', 'get() + a'])}`,
            ...(r.chance(0.15) ? ['  int _h = 1'] : []), ...(inner ? ['  class QI { int w = 3 } qi'] : []), ...(leaf ? [`  ref QL${index} leaf`] : []),
            `  method int get() { return ${inner ? 'a + qi.w' : leaf ? 'a + leaf.x' : 'a'} }`,
            ...(r.chance(0.5) ? [`  region QT { initial state QS do ${leaf ? 'leaf.x += 1' : 'a += 1'} go to QS }`] : []), '}'].join('\n'))
        if (leaf) children.push(`scchart QL${index} { int x = 3 }`)
        if (r.chance(0.2)) decls.push(`  class QA${index}1 { int a = 2 } clash`)
        decls.push(`  ref QA${index} qa[${size}]`)
        terms.push(r.pick([`qa[${size - 1}].get()`, `qa[${size - 1}].b`, 'qa[0].b + 1']))
    }
    if (r.chance(0.3)) {
        const use = r.pick(['method', 'region', 'both', 'init', 'inner'])
        children.push([`scchart QV${index} {`, '  input const int k', `  int x = ${use === 'init' ? 'k + 1' : '0'}`,
            ...(use === 'method' || use === 'both' ? ['  method int get() { return k }'] : []),
            ...(use === 'inner' ? ['  class QW { int w() { return k } } qw', '  method int get() { return qw.w() }'] : []),
            ...(use === 'region' || use === 'both' ? ['  region VT { initial state VS do x = k go to VS }'] : []), '}'].join('\n'))
        decls.push(`  ref QV${index} qv[2](${r.pick(['{3, 8}', '{3, 8}', '{3, 8}', '{1 + 2, 8}', '{0 to 2}', '{3, n}', '{3, 8, 9}'])})`)
        terms.push(use === 'method' || use === 'inner' || (use === 'both' && r.chance(0.5)) ? 'qv[1].get()' : 'qv[1].x')
    }
    if (r.chance(0.35)) {
        const kind = r.pick(['short', 'kept', 'both', 'none'])
        children.push([`scchart QE${index} {`, ...(kind === 'short' || kind === 'both' ? ['  method int two() { return 2 }'] : []),
            ...(kind === 'kept' || kind === 'both' ? ['  method int big() { int t = 0; for (int j = 0; j < 2; j++) { t += 1 } return t }'] : []),
            '  region ET { initial state ES }', '}'].join('\n'))
        const call = kind === 'none' ? undefined : kind === 'short' ? 'two()' : kind === 'kept' ? 'big()' : r.pick(['two()', 'big()'])
        if (r.chance(0.3)) {
            // Inside another instance, now and then one without a field of its own (KIELER's code does not compile then).
            children.push([`scchart QM${index} {`, ...(r.chance(0.8) ? ['  int w = 5'] : []), `  ref QE${index} e`, ...(call ? [`  method int run() { return e.${call} }`] : []), '}'].join('\n'))
            decls.push(`  ref QM${index} qm`)
            if (call && r.chance(0.8)) terms.push('qm.run()')
        } else {
            const array = r.chance(0.3)
            decls.push(`  ref QE${index} qe${array ? '[2]' : ''}`)
            if (call && r.chance(0.7)) terms.push(`qe${array ? '[1]' : ''}.${call}`)
        }
    }
    if (second && r.chance(0.5)) terms.push('k2.get()')
    if (!terms.length) return { decls, region: [], children }
    decls.push('  output int u = 0')
    const region = ['  region RX {']
    terms.forEach((t, i) => region.push(`    ${i ? '' : 'initial '}state X${i}`, `    do u ${i ? '+=' : '='} ${t} go to X${(i + 1) % terms.length}`))
    region.push('  }')
    return { decls, region, children }
}

/**
 * The `random` profile's chart: `random()` (C's rand() as a float in [0, 1]) and `randomize()` (srand(time(NULL)))
 * in the places KIELER's C code can call them: effects and triggers of two concurrent regions, the first tick (an
 * initial value, the initial state's entry action, an immediate transition: KIELER moves such code into reset()),
 * short methods it copies into place and one with a loop that stays a C function, a class instance's methods, a
 * referenced chart, and code nothing reaches (a method never called, a state never entered), which decides whether
 * KIELER's C file includes <stdlib.h>. The comparison finds the clock seconds KIELER seeded with (compare.ts).
 */
function randomChart(r: Rng, index: number): string {
    const lines = [`scchart Q${index} {`, '  input bool a, b, c, d', '  input int n', '  output int x = 0, y = 0, z = 0, w = 0', '  output float f = 0, g = 0']
    const draw = () => r.pick(['random() * 6', 'random() * 100', 'random() * 1000 + 1', '(random() + random()) * 10', 'random() * (n + 2)'])
    const roll = r.chance(0.5)
    const seed = r.chance(0.35)
    const big = r.chance(0.3)
    const die = r.chance(0.35)
    const sub = r.chance(0.25)
    if (r.chance(0.2)) lines.push(`  int k = ${draw()}`)
    if (roll) lines.push('  method int roll(int m) { return random() * m }')
    if (seed) lines.push('  method void seed() { randomize() }')
    if (big) lines.push('  method int big() { int t = 0; for (int j = 0; j < 2; j++) { t += random() * 4 } return t }')
    if (r.chance(0.15)) lines.push(r.pick(['  method void never() { randomize() }', '  method int neverRoll() { return random() * 3 }']))
    if (die) lines.push(`  class Die { int v = 0  void roll() { v = random() * 6 }${r.chance(0.6) ? '  void seed() { randomize() }' : ''} } die`)
    // The effects of the first region write x, y and f, those of the second z, w and g: no conflict between them.
    const effect = (first: boolean): string => {
        const [p, q, fl] = first ? ['x', 'y', 'f'] : ['z', 'w', 'g']
        const all = [`${p} = ${draw()}`, `${p} = ${draw()}`, `${p} += random() * 3`, `${fl} = random()`, 'randomize()', `randomize(); ${p} = ${draw()}`,
            `${p} = ${draw()}; ${q} = ${draw()}`, `${p} += 1`, `${q} = n`]
        if (roll) all.push(`${q} = roll(6)`, `${q} = roll(n + 1)`)
        if (seed) all.push('seed()', `seed(); ${p} = ${draw()}`)
        if (big) all.push(`${q} = big()`)
        if (die && first) all.push('die.roll(); y = die.v', 'die.roll()')
        if (die && first && lines.some(l => l.includes('void seed() { randomize() } } die'))) all.push('die.seed()')
        return r.pick(all)
    }
    const trigger = () => r.pick(['a', 'b', 'c', 'd', 'n > 1', 'a', 'b', ...(r.chance(0.3) ? ['random() < 0.5', 'a && random() < 0.7'] : [])])
    const go = (first: boolean, to: string, always = false) => `    ${r.chance(0.15) ? 'immediate ' : ''}${always && r.chance(0.3) ? '' : `if ${trigger()} `}do ${effect(first)} go to ${to}`
    if (r.chance(0.15)) lines.push(`  during do ${r.pick(['g = random()', 'w += random() * 2'])}`)
    const second = r.chance(0.5)
    lines.push('  region R1 {')
    lines.push(...(r.chance(0.2) ? ['    initial state A {', `      entry do ${effect(true)}`, '    }'] : ['    initial state A']))
    lines.push(go(true, 'B'))
    lines.push('    state B', go(true, 'A', true))
    if (r.chance(0.3)) lines.push(go(true, 'C'), '    state C', go(true, r.pick(['A', 'C']), true))
    if (r.chance(0.15)) lines.push('    state U', `    if a do ${r.pick(['randomize()', 'x = random() * 9'])} go to A`)
    lines.push('  }')
    if (second) {
        lines.push('  region R2 {', '    initial state P', go(false, r.pick(['P', 'P2'])))
        lines.push('    state P2', go(false, 'P', true), '  }')
    }
    if (sub) lines.push('  region R3 {', `    initial state S is QS${index}(${second ? 'k2' : 'w'})`, '  }')
    if (sub && second) lines.splice(5, 0, '  output int k2 = 0')
    lines.push('}')
    const charts = [lines.join('\n')]
    if (sub) charts.push([`scchart QS${index} {`, '  output int r', `  initial state I do ${r.pick(['r = random() * 50', 'randomize(); r = random() * 50', 'r += 1', 'randomize()'])} go to I`, '}'].join('\n'))
    // A chart of the file that nothing uses: its random() does not reach the C code.
    if (r.chance(0.1)) charts.push(`scchart QN${index} { output int q initial state I do q = random() * 3 go to I }`)
    return (r.chance(0.1) ? '#hostcode "#include <stdlib.h>"\n' : '') + charts.join('\n\n') + '\n'
}

/**
 * The `pointers` profile's chart: arrays used as values (sim/pointers.ts). An array named without all its indices is
 * its address in KIELER's C code, so the chart computes with addresses: differences and comparisons of arrays, rows,
 * members of a class and of a chart instance and locals of a state, a pointer moved by a number, pointers as
 * conditions and in conditionals, differences in long arithmetic, in effects and triggers of two concurrent regions,
 * in short methods (whose array parameter is the argument) and one KIELER keeps as a C function. Two matrices with
 * something odd between them give differences that are not whole rows. Now and then a form gcc rejects (an array
 * assigned, added, negated, as an index, in a conditional with a number), a float array cast to an int (which shows
 * the struct's address: the comparison finds it, compare.ts resolveAddress), and a difference in a difference or
 * under a minus sign, whose parentheses KIELER leaves out (sim/written.ts). A third of the values are random
 * expressions built by C's types (pointers to ints, pointers to rows, ints) up to three operators deep.
 */
function pointersChart(r: Rng, index: number): string {
    const lines = [`scchart P${index} {`, '  input bool a, b, c, d', '  input int n', '  output int x = 0, y = 0, z = 0, w = 0', '  output float f = 0', '  output bool t = false']
    const gap = r.chance(0.5)
    const cls = r.chance(0.35)
    const inst = r.chance(0.3)
    const local = r.chance(0.3)
    const short = r.chance(0.4)
    const kept = r.chance(0.35)
    lines.push('  int p[2] = {4, 7}', '  int q[3]')
    if (r.chance(0.3)) lines.push('  bool e0')
    lines.push('  int m[2][3]')
    if (gap) lines.push(r.pick(['  int k0', '  bool k0', '  int k0[3]']))
    lines.push('  int mm[2][3]', '  float fa[2]', '  bool ba[3]')
    if (cls) lines.push('  class K { int u  int r[2]  int s[2] } k')
    if (inst) lines.push(`  ref PG${index} g`)
    if (short) lines.push('  method int dist() { return q - p }', '  method int first(int v[2]) { return v[0] }', '  method int same(int v[2], int u[2]) { return v == u }')
    if (kept) lines.push(`  method int walk() { int s = 0 for (int j = 0; j < 2; j++) { ${r.pick(['s += (q - p) + (p == q)', 'if (p) { s += q - p }', 's += m[j] - m[0]', 's = s + (p < q)'])} } return s }`)
    // What computes: an int from addresses.
    const good = (): string => {
        const all = ['q - p', 'p - q', '(p + n) - p', '(p + 1) - p', 'm[1] - m[0]', 'm[n % 2] - m[0]', 'mm - m', 'm - mm', '(mm + n) - m', 'mm[1] - m[0]', 'mm[n % 2] - m[1]',
            '(fa + 1) - fa', '(ba + 2) - ba', 'p == q', 'p != q', 'p < q', 'p > q', 'p <= p', 'm[0] == m[1]', 'm == m[0]', '(m + 1) == m[1]', 'p == 0', 'p != 0', 'p < n', 'p > n - 2', 'n < p', '!p',
            'p && a', 'p || b', '(a ? p : q) == p', '(b ? p : 0) == q', '(q - p) * n', '(q - p) / 2', '(q - p) % 2', '(q - p) << 2', '~(q - p)', 'p == fa', 'ba == p', '(p + 2) == q',
            'q[q - p - 2]', 'q - p - n', 'n + (q - p)', '(p == q) + (p != q)', '(mm - m) * 3', '(q - p) * 1000000000 * 4 / 1000', '(q - p) > 1.5',
            // Sums and differences as KIELER writes them.
            '10 - (n - 2)', '-(n - 1)', 'n - (x - 1)', '20 - (n + 2 - 1)', '-(n - 2) * 3', '5 - -n', '30 - (n - (2 - 1))']
        if (cls) all.push('k.s - k.r', 'k.r - p', 'k.r == p', '(k.r + 2) == k.s')
        if (inst) all.push('g.h - g.v', 'g.v == p', 'g.v - p', 'g.h > g.v')
        if (short) all.push('dist()', 'first(p)', 'first(m[1])', 'same(p, q)', 'same(p, p)')
        if (kept) all.push('walk()')
        return r.pick(all)
    }
    // Random expressions over addresses, built by C's types: a pointer to an int, a pointer to a row, an int. Now and
    // then an operand of the wrong kind, which gcc mostly refuses.
    const element = (depth: number): string => {
        if (depth <= 0 || r.chance(0.45)) return r.pick(['p', 'q', 'm[0]', 'm[1]', 'mm[0]', 'm[n % 2]', 'mm[1]', ...(cls ? ['k.r', 'k.s'] : []), ...(inst ? ['g.v', 'g.h'] : [])])
        return r.pick([`(${element(depth - 1)} + ${int(depth - 1)})`, `(${element(depth - 1)} - ${int(depth - 1)})`, `(${int(depth - 1)} + ${element(depth - 1)})`,
            `(${r.pick(['a', 'b', 'c', 'n > 1'])} ? ${element(depth - 1)} : ${element(depth - 1)})`])
    }
    const row = (depth: number): string => (depth <= 0 || r.chance(0.6) ? r.pick(['m', 'mm']) : `(${row(depth - 1)} ${r.pick(['+', '-'])} ${int(depth - 1)})`)
    const int = (depth: number): string => {
        if (depth <= 0 || r.chance(0.3)) return r.pick(['n', 'x', '1', '2', '0', 'n - 1', 'q[1]'])
        const wrong = r.chance(0.04)
        const [u, v] = [wrong ? row(depth - 1) : element(depth - 1), element(depth - 1)]
        return r.pick([`(${u} - ${v})`, `(${u} ${r.pick(['==', '!=', '<', '<=', '>', '>='])} ${v})`, `(${row(depth - 1)} - ${row(depth - 1)})`, `(${row(depth - 1)} ${r.pick(['==', '<', '>'])} ${row(depth - 1)})`,
            `(${v} ${r.pick(['==', '!=', '<', '>'])} ${int(depth - 1)})`, `(${int(depth - 1)} ${r.pick(['+', '-', '*', '-'])} ${int(depth - 1)})`, `(!${v})`, `-(${int(depth - 1)})`,
            `(${v} ${r.pick(['&&', '||'])} ${int(depth - 1)})`, `(${int(depth - 1)} ${r.pick(['/', '%'])} ${r.pick(['2', '3', '(n + 1)'])})`, `(${u} - ${v}) ${r.pick(['*', '<<', '&', '|'])} ${r.pick(['2', 'n', '3'])}`])
    }
    // What gcc refuses.
    const bad = (): string => r.pick(['p', 'p + q', 'p * 2', '-p', '~p', 'p % 2', 'p & 1', '1 - p', 'a ? p : n', 'a ? p : fa', 'q[p]', 'm - m[0]', 'p - fa', 'p + 1.5', 'p == 1.5', 'p + 1', 'm[1]',
        'ba - p', '-(q - p)', '0 - (q - p)', '- -5', '- -(n + 1)', ...(short ? ['first(n)', 'first(m)'] : [])])
    const value = () => (r.chance(0.06) ? bad() : r.chance(0.35) ? int(r.pick([1, 2, 2, 3])) : good())
    // The effects of the first region write x, y, f and t, those of the second z and w: no conflict between them.
    const effect = (first: boolean): string => {
        const [u, v] = first ? ['x', 'y'] : ['z', 'w']
        const all = [`${u} = ${value()}`, `${u} = ${value()}`, `${v} = ${value()}`, `${u} = ${good()}; ${v} = ${good()}`, `${u} += ${r.pick(['q - p', 'p == q', 'm[1] - m[0]', '1'])}`,
            `${v} ${r.pick(['min=', 'max=', '-=', '*='])} ${r.pick(['q - p', 'mm - m', 'p != q'])}`, `${u} = n`, `${v} += 1`, `q[${r.pick(['0', '1', 'n % 3', 'q - p - 2'])}] = ${r.pick(['n', 'q - p', '3'])}`]
        if (first) all.push(`f = ${r.pick(['q - p', '(q - p) / 4.0', 'p == q', '(mm - m) / 2'])}`, `t = ${r.pick(['p == q', 'q - p', 'p != q', '(q - p) * 128', 'p && a'])}`)
        if (first && r.chance(0.3)) all.push(`print(${r.pick(['q - p', 'p == q', 'x'])})`)
        // A float array where an int is assigned: KIELER's `(int)` cast makes a number of the address.
        if (r.chance(0.08)) all.push(`${u} = ${r.pick(['fa', 'fa + 1', 'b ? fa : fa'])}`, `${u} += fa`)
        if (r.chance(0.04)) all.push(r.pick(['f = fa', 't = p', 'p = q', 'p++', `${u} = k0`]))
        return r.pick(all)
    }
    const trigger = () => r.pick(['a', 'b', 'c', 'd', 'n > 1', 'a', 'b', 'p && a', 'q - p', 'p == q', 'p != q', 'a && p < q', 'm[n % 2] - m[0]', '!p || c', '(q - p) * n', 'n - (x - 1) > 0',
        ...(r.chance(0.08) ? ['p', 'm[1]', 'a ? p : q'] : [])])
    const go = (first: boolean, to: string, always = false) => `    ${r.chance(0.15) ? 'immediate ' : ''}${always && r.chance(0.3) ? '' : `if ${trigger()} `}do ${effect(first)} go to ${to}`
    if (r.chance(0.15)) lines.push(`  during do w ${r.pick(['+= q - p', '= p == q', 'max= mm - m'])}`)
    const second = r.chance(0.5)
    lines.push('  region R1 {')
    if (local) lines.push('    initial state A {', '      int l[2]', `      ${r.pick(['entry', 'during'])} do y = ${r.pick(['l - p', 'l == p', '(l + 1) - l', 'l > q'])}`, '    }')
    else lines.push(...(r.chance(0.2) ? ['    initial state A {', `      entry do ${effect(true)}`, '    }'] : ['    initial state A']))
    lines.push(go(true, 'B'))
    lines.push('    state B', go(true, 'A', true))
    if (r.chance(0.3)) lines.push(go(true, 'C'), '    state C', go(true, r.pick(['A', 'C']), true))
    lines.push('  }')
    if (second) {
        lines.push('  region R2 {', '    initial state S', go(false, r.pick(['S', 'S2'])))
        lines.push('    state S2', go(false, 'S', true), '  }')
    }
    lines.push('}')
    const charts = [lines.join('\n')]
    if (inst) charts.push([`scchart PG${index} {`, '  int v[2]', '  int e', '  int h[2]', '}'].join('\n'))
    return charts.join('\n\n') + '\n'
}

export function generate(seed: number, profileName: string, index: number, ticks = 14): Job {
    const profile = PROFILES[profileName] ?? PROFILES.mix
    const rng = new Rng(seed * 7919 + index * 104729 + 17)
    const features = new Set<Feature>(profile.features)
    for (const f of profile.optional ?? []) if (rng.chance(profile.optionalRate ?? 0.4)) features.add(f)
    if (features.has('valued')) features.add('signals')
    if (features.has('timed')) features.add('clocks')
    const g = new Generator(rng, features, profile)
    const model = profileName === 'reincarnation' ? reincarnationChart(rng, index) : profileName === 'dataflowObjects' ? dataflowObjectsChart(rng, index) : profileName === 'random' ? randomChart(rng, index) : profileName === 'pointers' ? pointersChart(rng, index) : g.chart(index)
    return { name: `${profileName}-${seed}-${index}`, model, inputs: inputsFor(rng, ticks, features.has('clocks')), profile: profileName, features: [...features].sort() }
}

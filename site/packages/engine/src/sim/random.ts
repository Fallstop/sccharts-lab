// glibc's rand() (TYPE_3). KIELER's C simulation uses it unseeded (seed 1: the sequence starts 1804289383,
// 846930886, 1681692777, ...) until the chart calls randomize(), which is srand(time(NULL)) (basics.md B-29).

export interface RandState {
    /** The last 34 values of the additive feedback generator, as a ring buffer. */
    ring: number[]
    /** Index of the next value to compute (i in r[i]). */
    i: number
}

/**
 * glibc's srandom_r for the default generator (TYPE_3): the state `srand(seed)` leaves behind. `seed` is C's
 * `unsigned int` (0 is taken as 1); seed 1 is the state of a program that never seeds.
 */
export function newRandState(seed = 1): RandState {
    const r: number[] = new Array(34)
    // int32_t word = seed: a seed of 2^31 or more is a negative word, and C's division truncates.
    let word = (seed >>> 0 || 1) | 0
    r[0] = word
    for (let i = 1; i < 31; i++) {
        // 16807 * word % 2147483647 without overflowing 31 bits (Schrage's method, as glibc writes it).
        const hi = Math.trunc(word / 127773)
        const lo = word % 127773
        word = 16807 * lo - 2836 * hi
        if (word < 0) word += 2147483647
        r[i] = word
    }
    for (let i = 31; i < 34; i++) r[i] = r[i - 31]
    const state: RandState = { ring: r.map(v => v >>> 0), i: 34 }
    // glibc discards the first 310 outputs (r[34] .. r[343]).
    for (let k = 34; k < 344; k++) step(state)
    return state
}

/** `srand(seed)` on a running generator: `state` continues as a new generator seeded with `seed`. */
export function seedRandState(state: RandState, seed: number) {
    const fresh = newRandState(seed)
    state.ring = fresh.ring
    state.i = fresh.i
}

function step(state: RandState): number {
    const { ring } = state
    const i = state.i
    const v = (ring[(i - 31) % 34] + ring[(i - 3) % 34]) >>> 0
    ring[i % 34] = v
    state.i = i + 1
    return v
}

/** The next rand() result (0 .. 2147483647). */
export function rand(state: RandState): number {
    return step(state) >>> 1
}

/** KIELER's random(): ((float) rand() / RAND_MAX), computed in single precision. */
export function random(state: RandState): number {
    return Math.fround(Math.fround(rand(state)) / Math.fround(2147483647))
}

export function cloneRandState(state: RandState): RandState {
    return { ring: state.ring.slice(), i: state.i }
}

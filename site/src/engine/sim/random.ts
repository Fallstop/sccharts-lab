// glibc's rand() with its default state (TYPE_3, seed 1), which KIELER's C simulation uses unseeded
// (basics.md B-29): the sequence starts 1804289383, 846930886, 1681692777, ...

export interface RandState {
    /** The last 34 values of the additive feedback generator, as a ring buffer. */
    ring: number[]
    /** Index of the next value to compute (i in r[i]). */
    i: number
}

export function newRandState(): RandState {
    const r: number[] = new Array(34)
    r[0] = 1
    for (let i = 1; i < 31; i++) {
        // 16807 * r[i-1] % 2147483647 with Schrage's method semantics (glibc computes it exactly in 64 bits).
        let v = (16807 * r[i - 1]) % 2147483647
        if (v < 0) v += 2147483647
        r[i] = v
    }
    for (let i = 31; i < 34; i++) r[i] = r[i - 31]
    const state: RandState = { ring: r.map(v => v >>> 0), i: 34 }
    // glibc discards the first 310 outputs (r[34] .. r[343]).
    for (let k = 34; k < 344; k++) step(state)
    return state
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

// Geometry of transition paths: ELK's spline routing points as cubic Bézier segments, flattened for
// measuring lengths and placing decorators the way KLighD does (at a distance from either end).

import type { Point } from './types'

/** Rounds to 1/100 for compact, stable output. */
export const r2 = (n: number) => Math.round(n * 100) / 100

/** True when the points form a cubic Bézier chain: start, then three points per segment. */
export function isBezierChain(points: Point[]): boolean {
    return points.length >= 4 && (points.length - 1) % 3 === 0
}

/** SVG path data for routing points: a cubic chain when the count fits, else straight segments. */
export function pathData(points: Point[]): string {
    if (points.length === 0) return ''
    const p = (q: Point) => `${r2(q.x)} ${r2(q.y)}`
    let d = `M${p(points[0])}`
    if (isBezierChain(points)) {
        for (let i = 1; i < points.length; i += 3) d += `C${p(points[i])} ${p(points[i + 1])} ${p(points[i + 2])}`
    } else {
        for (let i = 1; i < points.length; i++) d += `L${p(points[i])}`
    }
    return d
}

function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
    const u = 1 - t
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t
    return { x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x, y: w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y }
}

/** The path as a polyline (16 samples per Bézier segment). */
export function flatten(points: Point[]): Point[] {
    if (!isBezierChain(points)) return points.slice()
    const out: Point[] = [points[0]]
    for (let i = 1; i < points.length; i += 3) {
        const a = points[i - 1], b = points[i], c = points[i + 1], d = points[i + 2]
        for (let s = 1; s <= 16; s++) out.push(cubic(a, b, c, d, s / 16))
    }
    return out
}

export interface PathSample {
    point: Point
    /** Unit tangent in the direction of travel. */
    tangent: Point
}

function polylineLength(poly: Point[]): number {
    let len = 0
    for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y)
    return len
}

/** The point at arc length `distance` from the start (negative: from the end), with the tangent there. */
export function sampleAt(poly: Point[], distance: number): PathSample {
    const total = polylineLength(poly)
    let target = distance < 0 ? total + distance : distance
    target = Math.max(0, Math.min(total, target))
    let walked = 0
    for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i]
        const seg = Math.hypot(b.x - a.x, b.y - a.y)
        if (seg === 0) continue
        if (walked + seg >= target || i === poly.length - 1) {
            const t = Math.min(1, (target - walked) / seg)
            return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, tangent: { x: (b.x - a.x) / seg, y: (b.y - a.y) / seg } }
        }
        walked += seg
    }
    const last = poly[poly.length - 1] ?? { x: 0, y: 0 }
    return { point: last, tangent: { x: 1, y: 0 } }
}

/** Tangent at the very end of the path (direction of arrival). */
export function endTangent(points: Point[]): Point {
    const end = points[points.length - 1]
    for (let i = points.length - 2; i >= 0; i--) {
        const dx = end.x - points[i].x, dy = end.y - points[i].y
        const len = Math.hypot(dx, dy)
        if (len > 1e-6) return { x: dx / len, y: dy / len }
    }
    return { x: 1, y: 0 }
}

/** Tangent at the very start of the path (direction of departure). */
export function startTangent(points: Point[]): Point {
    const start = points[0]
    for (let i = 1; i < points.length; i++) {
        const dx = points[i].x - start.x, dy = points[i].y - start.y
        const len = Math.hypot(dx, dy)
        if (len > 1e-6) return { x: dx / len, y: dy / len }
    }
    return { x: 1, y: 0 }
}

/** Transforms decorator-local points (x along the tangent, y to its right) to diagram coordinates. */
export function place(origin: Point, tangent: Point, local: [number, number][]): Point[] {
    return local.map(([x, y]) => ({ x: origin.x + x * tangent.x - y * tangent.y, y: origin.y + x * tangent.y + y * tangent.x }))
}

/** The polyline point nearest to `p`, with the tangent of its segment. */
export function nearest(poly: Point[], p: Point): PathSample {
    let best: PathSample = { point: poly[0], tangent: { x: 1, y: 0 } }
    let bestDist = Infinity
    for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1], b = poly[i]
        const dx = b.x - a.x, dy = b.y - a.y
        const len2 = dx * dx + dy * dy
        if (len2 === 0) continue
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        const q = { x: a.x + dx * t, y: a.y + dy * t }
        const dist = Math.hypot(p.x - q.x, p.y - q.y)
        if (dist < bestDist) {
            const len = Math.sqrt(len2)
            bestDist = dist
            best = { point: q, tangent: { x: dx / len, y: dy / len } }
        }
    }
    return best
}

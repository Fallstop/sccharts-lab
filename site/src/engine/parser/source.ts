// Source positions: converts UTF-16 offsets to the 1-based lines and columns of a Span.

import type { Span } from '../types'

export class LineMap {
    /** Offsets at which each line starts. */
    private readonly starts: number[] = [0]

    constructor(readonly text: string) {
        for (let i = 0; i < text.length; i++) {
            const c = text.charCodeAt(i)
            if (c === 10) this.starts.push(i + 1)
            else if (c === 13 && text.charCodeAt(i + 1) !== 10) this.starts.push(i + 1)
        }
    }

    /** 1-based line and column of an offset. */
    position(offset: number): { line: number; col: number } {
        const starts = this.starts
        let lo = 0
        let hi = starts.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (starts[mid] <= offset) lo = mid
            else hi = mid - 1
        }
        return { line: lo + 1, col: offset - starts[lo] + 1 }
    }

    span(start: number, end: number): Span {
        const a = this.position(start)
        const b = end === start ? a : this.position(end)
        return { start, end, line: a.line, col: a.col, endLine: b.line, endCol: b.col }
    }
}

/** The smallest span covering both. */
export function joinSpans(a: Span, b: Span): Span {
    const first = a.start <= b.start ? a : b
    const last = a.end >= b.end ? a : b
    return { start: first.start, end: last.end, line: first.line, col: first.col, endLine: last.endLine, endCol: last.endCol }
}

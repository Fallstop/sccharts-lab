// The playground's own charts: complete examples to explore, each verified with KIELER (the oracle recordings next
// to them: `pnpm oracle:record src/components/playground/showcase`). Build-time module (eager sources).

import type { ShowcaseEntry } from './catalogue'

export const SHOWCASE: ShowcaseEntry[] = [
    { id: 'showcase/abro', title: 'ABRO', file: 'abro', blurb: 'Wait for A and B in any order, emit O, start over on R.' },
    { id: 'showcase/stopwatch', title: 'Stopwatch', file: 'stopwatch', blurb: 'Start, stop, clear and a lap display, in two regions.' },
    { id: 'showcase/level-crossing', title: 'LevelCrossing', file: 'level-crossing', blurb: 'A sketch of a railway crossing: count delays and a fail-safe abort.' },
    { id: 'showcase/adder', title: 'Adder', file: 'adder', blurb: 'Valued signals: two regions emit into one signal with combine +.' },
]

const raw = import.meta.glob('./showcase/*.sctx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** Sources by id (`showcase/abro`). */
export function showcaseSources(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [path, text] of Object.entries(raw)) out[`showcase/${path.replace(/^\.\/showcase\//, '').replace(/\.sctx$/, '')}`] = text
    return out
}

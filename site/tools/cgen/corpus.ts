// The recorded scenarios (the same set as tests/conformance/engine.test.ts, plus the playground's showcase): every
// `<name>.oracle.json` next to its `<name>.sctx` and `<name>.scenario.json`.

import fs from 'node:fs'
import path from 'node:path'
import type { Case, Recording, Scenario } from './compare'

export const ROOTS = ['tests/conformance', 'src/examples', 'tests/engine/kieler', 'src/components/playground/showcase']

function* walk(dir: string): Generator<string> {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

export function collectCases(site: string, filter?: (id: string) => boolean): Case[] {
    const out: Case[] = []
    for (const root of ROOTS) {
        for (const file of walk(path.join(site, root))) {
            if (!file.endsWith('.oracle.json')) continue
            const base = file.slice(0, -'.oracle.json'.length)
            const chart = `${base}.sctx`
            const scenarioFile = `${base}.scenario.json`
            if (!fs.existsSync(chart) || !fs.existsSync(scenarioFile)) continue
            const id = `${root}/${path.relative(path.join(site, root), base).split(path.sep).join('/')}`
            if (filter && !filter(id)) continue
            const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) as Scenario
            const recording = JSON.parse(fs.readFileSync(file, 'utf8')) as Recording
            const files: Record<string, string> = {}
            for (const f of scenario.imports ?? []) files[path.basename(f)] = fs.readFileSync(path.join(path.dirname(chart), f), 'utf8')
            out.push({
                id, source: fs.readFileSync(chart, 'utf8'), files, scenario, recording,
                inputs: scenario.ticks.map(t => t.inputs ?? {}),
            })
        }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
}

// Shrinks a chart on which the engine and KIELER disagree to a small one with the same kind of disagreement
// (compare.ts OutcomeKind), by greedy deletion: whole blocks, states' bodies, single lines, parts of transitions
// and actions, other charts of the file. Each candidate is checked by the engine first (cheap) and then by KIELER.
//
//   node --experimental-transform-types --no-warnings --import ./tools/fuzz/register.mjs tools/fuzz/reduce.ts \
//       fuzz-out/mismatches/mix-1-3.json [--out reduced.sctx] [--timeout 40]
//
// The input is a mismatch file written by run.ts ({ model, inputs, outcome }), or a chart with --inputs file.json
// and --kind <outcome kind>. Writes <out> (default: next to the input, `.reduced.sctx`) and `<out>.json`.

import fs from 'node:fs'
import { compareWithOracle, engineVerdict, type OutcomeKind } from './compare'
import { OracleRunner } from './oracle'

type Inputs = Record<string, boolean | number>[]

function blocks(lines: string[]): [number, number][] {
    const out: [number, number][] = []
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trimEnd().endsWith('{')) continue
        let depth = 0
        for (let j = i; j < lines.length; j++) {
            depth += (lines[j].match(/\{/g)?.length ?? 0) - (lines[j].match(/\}/g)?.length ?? 0)
            if (depth === 0) {
                out.push([i, j])
                break
            }
        }
    }
    return out
}

const SIMPLIFY: [RegExp, string][] = [
    [/ do [^;]*?(?= (go|abort|join) to)/, ''],
    [/ if .*?(?= (do|go to|abort to|join to))/, ''],
    [/ (deep )?deferred/, ''],
    [/ (shallow )?history/, ''],
    [/\bimmediate /, ''],
    [/\bdelayed /, ''],
    [/if \d+ /, 'if '],
    [/\bweak (?=(entry|exit|suspend))/, ''],
    [/\bstrong (?=exit)/, ''],
    [/abort to/, 'go to'],
    [/join to/, 'go to'],
    [/; [^;]*?(?= (go|abort|join) to)/, ''],
    [/^(\s*)abort region/, '$1region'],
    [/^(\s*)final region/, '$1region'],
    [/ if [^d]*?(?= do)/, ''],
    [/; [^;]+$/, ''],
]

function candidates(lines: string[]): string[][] {
    const out: string[][] = []
    for (const [i, j] of blocks(lines)) {
        if (i === 0) continue
        out.push([...lines.slice(0, i), ...lines.slice(j + 1)])
        const head = lines[i].trimEnd().slice(0, -1).trimEnd()
        if (/\bstate\b/.test(head)) out.push([...lines.slice(0, i), head, ...lines.slice(j + 1)])
    }
    // Other charts of the file (generated referenced charts): drop them.
    lines.forEach((l, i) => {
        if (i > 0 && l.startsWith('scchart ')) {
            const end = lines.findIndex((x, k) => k > i && x === '}')
            if (end > 0) out.push([...lines.slice(0, i), ...lines.slice(end + 1)])
        }
    })
    lines.forEach((l, i) => {
        if (i === 0 || l.includes('{') || l.includes('}')) return
        out.push([...lines.slice(0, i), ...lines.slice(i + 1)])
        for (const [re, rep] of SIMPLIFY) {
            const m = l.replace(re, rep)
            if (m !== l) out.push([...lines.slice(0, i), m, ...lines.slice(i + 1)])
        }
    })
    out.sort((a, b) => a.join('\n').length - b.join('\n').length)
    return out
}

/** What the engine alone must say for a candidate to keep the disagreement (an engine rejection: the same error). */
function engineAgrees(kind: OutcomeKind, verdict: string, original: string): boolean {
    switch (kind) {
        case 'engine-accepts': case 'behaviour': return verdict === 'ok'
        case 'engine-rejects': return verdict === original
        case 'engine-crash': return verdict.startsWith('crash')
        default: return verdict !== 'syntax'
    }
}

async function main() {
    const argv = process.argv.slice(2)
    const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
    const input = argv[0]
    let model: string
    let inputs: Inputs
    let kind: OutcomeKind
    if (input.endsWith('.json')) {
        const m = JSON.parse(fs.readFileSync(input, 'utf8'))
        model = m.model
        inputs = m.inputs
        kind = (opt('--kind') as OutcomeKind) ?? m.outcome.kind
        // A behaviour difference needs only the ticks up to the first that differs.
        if (kind === 'behaviour' && m.outcome.tick) inputs = inputs.slice(0, m.outcome.tick)
    } else {
        model = fs.readFileSync(input, 'utf8')
        inputs = JSON.parse(fs.readFileSync(opt('--inputs')!, 'utf8'))
        kind = opt('--kind') as OutcomeKind
    }
    const out = opt('--out') ?? input.replace(/\.(json|sctx)$/, '.reduced.sctx')
    const oracle = new OracleRunner(Number(opt('--timeout') ?? 40) * 1000)
    let calls = 0
    const original = engineVerdict(model)
    const keeps = async (text: string): Promise<boolean> => {
        if (!engineAgrees(kind, engineVerdict(text), original)) return false
        if (kind === 'engine-crash') return true
        calls++
        const rec = await oracle.run({ name: `reduce${calls}`, model: text, inputs })
        if (rec.timedOut) return false
        return compareWithOracle(text, inputs as never, rec).kind === kind
    }
    try {
        if (!(await keeps(model))) throw new Error(`the input does not show a '${kind}' disagreement`)
        let cur = model.split('\n')
        for (let round = 1; ; round++) {
            let found: string[] | undefined
            for (const c of candidates(cur)) {
                if (await keeps(c.join('\n'))) {
                    found = c
                    break
                }
            }
            console.error(`round ${round}: ${cur.length} lines${found ? ` -> ${found.length}` : ', done'} (${calls} KIELER runs)`)
            if (!found) break
            cur = found
            fs.writeFileSync(out, cur.join('\n'))
        }
        // Fewer ticks.
        while (inputs.length > 1) {
            const shorter = inputs.slice(0, -1)
            const saved = inputs
            inputs = shorter
            if (!(await keeps(cur.join('\n')))) { inputs = saved; break }
        }
        const text = cur.join('\n').trimEnd() + '\n'
        fs.writeFileSync(out, text)
        const rec = await oracle.run({ name: 'final', model: text, inputs })
        const outcome = compareWithOracle(text, inputs as never, rec)
        fs.writeFileSync(`${out}.json`, JSON.stringify({ model: text, inputs, outcome, kieler: rec }, null, 1))
        console.log(text)
        console.log(JSON.stringify(outcome))
    } finally {
        await oracle.close()
    }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })

// The code samples of the packages' documentation (src/components/packages/samples, shown by <Sample>) work:
// every .mjs runs here, in a directory that holds the samples' charts, and prints exactly the .out.txt beside it
// (the output the page shows; `vitest -u` records it); every .ts and .mjs type-checks against the packages; main.c
// builds with gcc against the generated code and prints its .out.txt. The samples that need the built packages
// (BUILT_ONLY) run in the packages' smoke test instead (tools/packages/smoke.mjs runs every sample there).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { format } from 'node:util'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUILT_ONLY, SAMPLES, sampleFiles } from './support'

const scripts = sampleFiles('.mjs')
const typed = sampleFiles('.ts')
const hasGcc = spawnSync('gcc', ['--version']).status === 0

let cwd: string
let work: string

beforeAll(() => {
    cwd = process.cwd()
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-lab-docs-samples-'))
    // The charts the samples read by name, as a reader has them beside the script.
    for (const file of sampleFiles('.sctx')) fs.copyFileSync(path.join(SAMPLES, file), path.join(work, path.basename(file)))
    process.chdir(work)
})
afterAll(() => {
    process.chdir(cwd)
    fs.rmSync(work, { recursive: true, force: true })
})

/** Runs a sample and returns what it printed, as the terminal shows it. */
async function run(file: string): Promise<string> {
    const lines: string[] = []
    const log = console.log
    console.log = (...args: unknown[]) => void lines.push(format(...args))
    try {
        await import(/* @vite-ignore */ `${pathToFileURL(path.join(SAMPLES, file)).href}?run=${Date.now()}`)
    } finally {
        console.log = log
    }
    return lines.join('\n') + '\n'
}

describe('the samples run and print what the pages show', () => {
    for (const file of scripts) {
        it.skipIf(BUILT_ONLY.has(file))(file, async () => {
            await expect(await run(file)).toMatchFileSnapshot(path.join(SAMPLES, file.replace(/\.mjs$/, '.out.txt')))
        })
    }

    it('every sample that prints has its output recorded, and no recording is left over', () => {
        const recorded = sampleFiles('.out.txt').map((f) => f.replace(/\.out\.txt$/, ''))
        const sources = new Set([...scripts.map((f) => f.replace(/\.mjs$/, '')), ...sampleFiles('.c').map((f) => f.replace(/\.c$/, ''))])
        expect(recorded.filter((r) => !sources.has(r))).toEqual([])
    })

    it.skipIf(!hasGcc)('quick-start/main.c builds against the generated code and prints its output', async () => {
        await run('quick-start/generate-c.mjs')
        fs.copyFileSync(path.join(SAMPLES, 'quick-start/main.c'), path.join(work, 'main.c'))
        execFileSync('gcc', ['-Wall', '-Wextra', '-Werror', '-o', 'turnstile', 'main.c', 'Turnstile.c'], { cwd: work, stdio: 'pipe' })
        const printed = execFileSync(path.join(work, 'turnstile'), { cwd: work, encoding: 'utf8' })
        await expect(printed).toMatchFileSnapshot(path.join(SAMPLES, 'quick-start/main.out.txt'))
    })
})

describe('the samples fit the page', () => {
    // At the size the packages' pages set code (overrides/packages-nav.ts), 74 characters fit the column.
    it('no line of a sample is longer than 74 characters', () => {
        const long: string[] = []
        for (const file of sampleFiles('').filter((f) => /\.\w+$/.test(f) && !f.endsWith('.out.txt'))) {
            fs.readFileSync(path.join(SAMPLES, file), 'utf8')
                .split('\n')
                .forEach((line, i) => line.length > 74 && long.push(`${file}:${i + 1} (${line.length})`))
        }
        expect(long).toEqual([])
    })
})

describe('the samples type-check against the packages', () => {
    const site = path.resolve(SAMPLES, '../../../..')
    const base: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
        types: ['node', 'vite/client'],
        typeRoots: [path.join(site, 'node_modules/@types'), path.join(site, 'node_modules')],
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        noEmit: true,
    }
    const problems = (files: string[], options: ts.CompilerOptions): string[] => {
        const roots = files.map((f) => path.join(SAMPLES, f))
        const program = ts.createProgram(roots, { ...base, ...options })
        return roots.flatMap((root) => {
            const source = program.getSourceFile(root)
            if (!source) return [`${root}: not in the program`]
            return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)].map((d) => {
                const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined
                return `${path.relative(SAMPLES, root)}${at ? `:${at.line + 1}:${at.character + 1}` : ''} ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`
            })
        })
    }

    it('TypeScript samples, strict', { timeout: 120_000 }, () => {
        expect(problems(typed, { strict: true })).toEqual([])
    })

    // JavaScript samples are checked as a JavaScript project is: names, arguments and options must exist, but a
    // value that may be undefined needs no guard.
    it('JavaScript samples', { timeout: 120_000 }, () => {
        expect(problems(scripts, { allowJs: true, checkJs: true, strict: false })).toEqual([])
    })
})

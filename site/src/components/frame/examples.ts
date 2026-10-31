// Example charts for the guide's widgets. Every `.sctx` file under src/examples is bundled as raw text at
// build time; a widget names its example by path without the extension:
//
//   <Sim example="learn/first-chart/toggle" />   ->  src/examples/learn/first-chart/toggle.sctx
//
// A missing example is a build error that names the file, so a typo never ships as an empty widget.

const sources = import.meta.glob('/src/examples/**/*.sctx', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>

const scenarios = import.meta.glob('/src/examples/**/*.scenario.json', {
    import: 'default',
    eager: true,
}) as Record<string, Scenario>

const recordings = import.meta.glob('/src/examples/**/*.oracle.json', {
    import: 'default',
    eager: true,
}) as Record<string, OracleRecording>

/** `<name>.oracle.json` (pnpm oracle:record): what KIELER said about the chart. Only the parts widgets use. */
export interface OracleRecording {
    /** The recorded chart, repository-relative (`src/examples/learn/x/y.sctx`). */
    chart?: string
    ok: boolean
    /** Why the compilation failed: syntax errors (`line:col message`), then the compiler's errors. */
    errors?: string[]
    /** The compiler's warnings (e.g. `Potential instantaneous loop.`). */
    warnings?: string[]
    /** KIELER's parse and validation messages, LSP severities (1 = error, 2 = warning, 3 = information),
     *  with 1-based line and column. */
    diagnostics?: { severity: number; message: string; line?: number; column?: number }[]
    ticks?: { step: number; inputs: Record<string, unknown>; values: Record<string, unknown>; terminated?: boolean }[]
    /** The simulated chart's interface: name -> type and properties (`input`, `output`, `signal`, ...). */
    interface?: Record<string, { type?: string; properties?: string[] }>
}

/** `<name>.scenario.json`, see docs-internal/CONTENT-PLAN.md. */
export interface Scenario {
    ticks: { inputs?: Record<string, unknown>; note?: string }[]
    expect?: 'ok' | 'error'
    errorIncludes?: string
    /** Other files the chart imports, relative to it (`["push-switch.sctx"]`): the oracle and the widgets
     *  compile the chart with them (`compile(source, { files })`). */
    imports?: string[]
    /** The compiler the recording used ('netlist' by default; 'priority' for the priority-based one). */
    system?: string
}

export interface Example {
    /** As written in the widget, normalised: `learn/first-chart/toggle`. */
    id: string
    /** Repository-relative path of the source: `src/examples/learn/first-chart/toggle.sctx`. */
    file: string
    source: string
    /** Name of the first `scchart` in the file (the one KIELER and the engine simulate), read with a regular
     *  expression. The widgets take the name from compile(). */
    chartName?: string
    /** The files the chart imports, by file name (`{ "push-switch.sctx": "..." }`), for
     *  `compile(source, { files })`: the scenario's `imports`, else every `import "name"` of the source that
     *  has a file next to the example. Empty when it imports nothing. */
    files: Record<string, string>
    scenario?: Scenario
    /** KIELER's verdict, when the example has been recorded with the oracle. */
    oracle?: OracleRecording
}

/** A simple, regex-level view of a chart's interface, for placeholders that run without the engine. */
export interface InterfaceItem {
    name: string
    direction: 'input' | 'output' | 'inout'
    /** `bool`, `int`, `float`, `string`, or `signal` for a pure signal. */
    type: string
}

function normalise(id: string): string {
    return id
        .trim()
        .replace(/^\/+/, '')
        .replace(/^src\/examples\//, '')
        .replace(/\.sctx$/, '')
}

function keyOf(id: string): string {
    return `/src/examples/${id}.sctx`
}

/** Example ids that exist, for error messages and the playground's example list. */
export function exampleIds(): string[] {
    return Object.keys(sources)
        .map((k) => k.replace(/^\/src\/examples\//, '').replace(/\.sctx$/, ''))
        .sort()
}

/**
 * Loads an example or throws an error naming the expected file.
 * @param usedBy How the widget was written, for the message, e.g. `<Sim example="...">`.
 */
export function loadExample(rawId: string | undefined, usedBy: string): Example {
    if (!rawId || !rawId.trim()) {
        throw new Error(`${usedBy}: the "example" prop is missing. Name a file under src/examples without .sctx, e.g. example="learn/first-chart/toggle".`)
    }
    const id = normalise(rawId)
    const source = sources[keyOf(id)]
    if (source === undefined) {
        const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : ''
        const near = exampleIds().filter((e) => dir && e.startsWith(dir))
        const hint = near.length ? ` Examples in src/examples/${dir}: ${near.join(', ')}.` : ''
        throw new Error(`${usedBy}: no example file at src/examples/${id}.sctx. Create it, or fix the example path.${hint}`)
    }
    const scenario = scenarios[`/src/examples/${id}.scenario.json`]
    const oracle = recordings[`/src/examples/${id}.oracle.json`]
    const files = importsOf(id, source, scenario, usedBy)
    return { id, file: `src/examples/${id}.sctx`, source, chartName: chartNameOf(source), scenario, oracle, files }
}

/** The files an example imports (see `Example.files`). A missing file named in the scenario is a build error. */
function importsOf(id: string, source: string, scenario: Scenario | undefined, usedBy: string): Record<string, string> {
    const dir = id.includes('/') ? id.slice(0, id.lastIndexOf('/') + 1) : ''
    const files: Record<string, string> = {}
    if (scenario?.imports) {
        for (const f of scenario.imports) {
            const rel = f.replace(/^\.\//, '').replace(/\.sctx$/, '')
            const text = sources[keyOf(`${dir}${rel}`)]
            if (text === undefined) throw new Error(`${usedBy}: the scenario of ${id} imports ${f}, but there is no src/examples/${dir}${rel}.sctx.`)
            files[`${rel.split('/').at(-1)}.sctx`] = text
        }
        return files
    }
    for (const m of stripComments(source).matchAll(/^\s*import\s+"([^"]+)"/gm)) {
        const rel = m[1].replace(/^\.\//, '').replace(/\.sctx$/, '')
        const text = sources[keyOf(`${dir}${rel}`)]
        if (text !== undefined) files[`${rel.split('/').at(-1)}.sctx`] = text
    }
    return files
}

/** Loads a scenario file by example-style id (`learn/x/y` -> `learn/x/y.scenario.json`), or throws. */
export function loadScenario(rawId: string, usedBy: string): Scenario {
    const id = normalise(rawId).replace(/\.scenario(\.json)?$/, '')
    const scenario = scenarios[`/src/examples/${id}.scenario.json`]
    if (!scenario) throw new Error(`${usedBy}: no scenario file at src/examples/${id}.scenario.json.`)
    return scenario
}

/** The oracle recording of a scenario file by example-style id (`learn/x/y` -> `learn/x/y.oracle.json`). */
export function loadRecording(rawId: string): OracleRecording | undefined {
    const id = normalise(rawId).replace(/\.scenario(\.json)?$/, '').replace(/\.oracle(\.json)?$/, '')
    return recordings[`/src/examples/${id}.oracle.json`]
}

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const chartHead = /\bscchart\s+([A-Za-z_][\w]*)/g

/** The first `scchart Name` in the source: the one KIELER (and the guide's engine) simulates. */
export function chartNameOf(source: string): string | undefined {
    return [...stripComments(source).matchAll(chartHead)][0]?.[1]
}

/**
 * Inputs and outputs of the first chart (the simulated one), read with regular expressions. Good enough to
 * label a placeholder's controls and trace rows; the real widgets use the engine's `interface`.
 */
export function interfaceOf(source: string): InterfaceItem[] {
    const text = stripComments(source)
    const heads = [...text.matchAll(chartHead)]
    const start = heads[0]?.index ?? -1
    const end = heads[1]?.index ?? text.length
    const body = start >= 0 ? text.slice(start, end) : text
    const items: InterfaceItem[] = []
    const decl = /^[ \t]*((?:(?:input|output|global|static|const|extern)\s+)+)(signal\s+)?(?:(bool|int|float|string|pure)\s+)?([^\n]+)/gm
    for (const m of body.matchAll(decl)) {
        const mods = m[1]
        const input = /\binput\b/.test(mods)
        const output = /\boutput\b/.test(mods)
        if (!input && !output) continue
        const type = m[3] ?? (m[2] ? 'signal' : 'bool')
        const names = m[4]
            .replace(/=[^,]*/g, '')
            .replace(/\[[^\]]*\]/g, '')
            .replace(/\bcombine\b.*$/, '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^[A-Za-z_]\w*$/.test(s))
        for (const name of names) {
            items.push({ name, direction: input && output ? 'inout' : input ? 'input' : 'output', type: m[2] && m[3] ? m[3] : type })
        }
    }
    return items
}

/** The playground URL that opens an example. `solution`: the id of a model solution (a TryIt exercise), which
 *  the playground offers to compare with (`&solution=<id>`). */
export function playgroundHref(id: string, solution?: string): string {
    return `/playground/?example=${encodeURIComponent(id)}${solution ? `&solution=${encodeURIComponent(solution)}` : ''}`
}

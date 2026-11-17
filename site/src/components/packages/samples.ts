// The code samples of the packages' documentation: real files in ./samples, shown on the pages by <Sample> and run
// by tests/packages-docs (every .mjs is executed and its output compared with the .out.txt beside it, every .ts is
// type-checked), so a page cannot show code that does not work or output it does not give.
//
// A part of a file is shown by its region: lines between `// #region name` and `// #endregion` (the markers
// themselves are never shown).

const REGION = /^\s*(?:\/\/|\/\*|<!--)\s*#(region|endregion)\b\s*([\w-]*)/

/** The file without its region markers; with `region`, only that region's lines, without their shared indentation. */
export function sampleText(text: string, region?: string, file = 'sample'): string {
    const lines = text.replace(/\n$/, '').split('\n')
    if (!region) return lines.filter((l) => !REGION.test(l)).join('\n')
    const out: string[] = []
    let inside = false
    let found = false
    for (const line of lines) {
        const m = REGION.exec(line)
        if (m) {
            if (m[1] === 'region' && m[2] === region) inside = found = true
            else if (m[1] === 'endregion') inside = false
            continue
        }
        if (inside) out.push(line)
    }
    if (!found) throw new Error(`${file} has no region "${region}"`)
    const indent = Math.min(...out.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length))
    return out.map((l) => l.slice(indent)).join('\n').replace(/^\n+|\n+$/g, '')
}

const LANGUAGES: Record<string, string> = { mjs: 'js', js: 'js', ts: 'ts', sctx: 'sctx', c: 'c', h: 'c', html: 'html', css: 'css', txt: 'text', csv: 'text', sh: 'sh', json: 'json' }

/** The highlighting language of a sample file, by its extension. */
export function sampleLanguage(file: string): string {
    return LANGUAGES[file.slice(file.lastIndexOf('.') + 1)] ?? 'text'
}

/** `quick-start/compile.mjs` -> `quick-start/compile.out.txt`: what the sample prints, recorded by the test. */
export function outputFile(file: string): string {
    return file.replace(/\.[^./]+$/, '.out.txt')
}

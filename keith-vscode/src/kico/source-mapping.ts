import type { SourceLocation } from './diagnostic-protocol'

interface HostBlock {
    code: string
    offsets: number[]
    start: number
    end: number
}

function codeMask(source: string): string {
    return source.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (token) =>
        token.replace(/[^\r\n]/g, ' ')
    )
}

/** Decode embedded C while retaining the original offset of every decoded character. */
export function hostBlocks(source: string): HostBlock[] {
    const blocks: HostBlock[] = []
    const opening = /^\s*#hostcode-c\s+"/gm
    const mask = codeMask(source)
    while (opening.exec(source) !== null) {
        let code = ''
        const offsets: number[] = []
        let i = opening.lastIndex
        const start = i
        for (; i < source.length && source[i] !== '"'; i++) {
            offsets.push(i)
            if (source[i] === '\\' && i + 1 < source.length) {
                i++
                const escaped: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
                code += escaped[source[i]] ?? source[i]
            } else code += source[i]
        }
        if (mask.slice(0, start).trimEnd().endsWith('#hostcode-c')) blocks.push({ code, offsets, start, end: i })
        opening.lastIndex = i + 1
    }
    return blocks
}

export function utf8ColumnOffset(line: string, byteColumn: number): number {
    let bytes = 0
    let offset = 0
    for (const char of line) {
        const size = Buffer.byteLength(char, 'utf8')
        if (bytes + size > byteColumn) break
        bytes += size
        offset += char.length
    }
    return offset
}

/** Only map unique matches; retain the generated-file location whenever provenance is ambiguous. */
export function mapNativeLocation(uri: string, source: string, location: SourceLocation): SourceLocation | undefined {
    const line = location.generatedLine
    if (!line?.trim()) return undefined
    const blocks = hostBlocks(source)
    const matches: SourceLocation[] = []
    for (const block of blocks) {
        let offset = 0
        for (const embedded of block.code.split('\n')) {
            if (embedded.replace(/\r$/, '') === line.replace(/\r$/, '')) {
                const column = utf8ColumnOffset(line, Math.max(0, location.column ?? 0))
                const position = block.offsets[offset + column]
                const token = line.slice(column).match(/^[A-Za-z_][\w]*/)?.[0] ?? line[column] ?? ''
                const last = block.offsets[offset + column + Math.max(0, token.length - 1)]
                if (position !== undefined)
                    matches.push({
                        uri,
                        offset: position,
                        length: Math.max(1, (last ?? position) - position + 1),
                        label: `Embedded C: ${location.label}`,
                    })
            }
            offset += embedded.length + 1
        }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) return undefined

    // Simple whole-array copies have a direct, unambiguous source equivalent.
    const assignment = line.match(/^\s*d->([A-Za-z_]\w*)\s*=\s*d->([A-Za-z_]\w*)\s*;\s*$/)
    if (!assignment) return undefined
    const expression = new RegExp(`\\b${assignment[1]}\\s*=\\s*${assignment[2]}\\b`, 'g')
    for (const match of codeMask(source).matchAll(expression)) {
        matches.push({
            uri,
            offset: match.index,
            length: match[0].length,
            label: source.slice(match.index, match.index + match[0].length),
        })
    }
    return matches.length === 1 ? matches[0] : undefined
}

export function arrayCopyFix(source: string, location: SourceLocation): string | undefined {
    const expression = source.slice(location.offset, location.offset + location.length)
    const names = expression.trim().match(/^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)$/)
    if (!names) return undefined
    const mask = codeMask(source)
    if (
        names
            .slice(1)
            .some((name) => [...mask.matchAll(new RegExp(`\\b(?:int|bool|float)\\s+${name}\\b`, 'g'))].length !== 1)
    )
        return undefined
    const sizes = names
        .slice(1)
        .map((name) => [...mask.matchAll(new RegExp(`\\b(int|bool|float)\\s+${name}\\[(\\d+)\\]`, 'g'))])
    if (
        sizes.some((entries) => entries.length !== 1) ||
        sizes[0][0][1] !== sizes[1][0][1] ||
        sizes[0][0][2] !== sizes[1][0][2]
    )
        return undefined
    const size = Number(sizes[0][0][2])
    if (size < 1 || size > 64) return undefined
    const lineStart = source.lastIndexOf('\n', location.offset) + 1
    const indent = source.slice(lineStart, location.offset).match(/^\s*/)?.[0] ?? ''
    return (
        (expression.match(/^\s*/)?.[0] ?? '') +
        Array.from({ length: size }, (_, i) => `${names[1]}[${i}] = ${names[2]}[${i}]`).join(`;\n${indent}`) +
        (expression.match(/\s*$/)?.[0] ?? '')
    )
}

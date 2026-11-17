// What the packages really export, read from their sources with the TypeScript compiler, and what an API page of
// their documentation says, read from its Markdown: api.test.ts compares the two.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { PAGES, SITE } from './support'

export type PackageName = 'engine' | 'diagram' | 'trace' | 'embed'

/** A member of an interface, a type literal or a class: its name as the pages write it and its type as the source does. */
export interface Member {
    /** `chart?`, `tick`, `step()` */
    label: string
    /** The source's type text; for a method, `(parameters) => result`. */
    type: string
}

export interface Exported {
    name: string
    kind: 'function' | 'interface' | 'type' | 'const' | 'class'
    /** function: `function name(a: A, b?: B): R`; type: `type Name = ...`; const: `const NAME: T` when the source says T. */
    signature?: string
    /** interface, object type alias, class: its own members (not inherited ones). */
    members?: Member[]
}

const squash = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/\s+/g, '')
/** Text compared without whitespace and comments: the pages may break a long signature over lines. */
export const same = (a: string, b: string) => squash(a) === squash(b)

/** Parameters as a declaration file writes them: a default value becomes `?`, a type left to inference is named. */
function parameters(list: ts.NodeArray<ts.ParameterDeclaration>, checker?: ts.TypeChecker): string {
    const typeOf = (p: ts.ParameterDeclaration) => p.type?.getText() ?? (checker ? checker.typeToString(checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(p))) : 'unknown')
    return list.map((p) => `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${p.questionToken || p.initializer ? '?' : ''}: ${typeOf(p)}`).join(', ')
}

function membersOf(nodes: readonly ts.Node[]): Member[] {
    const out: Member[] = []
    for (const m of nodes) {
        if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
            if (ts.isPrivateIdentifier(m.name) || (ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Static))) continue
            out.push({ label: `${m.name.getText()}${m.questionToken ? '?' : ''}`, type: m.type?.getText() ?? '' })
        } else if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
            if (ts.isPrivateIdentifier(m.name) || (ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Static))) continue
            out.push({ label: `${m.name.getText()}()`, type: `(${parameters(m.parameters)}) => ${m.type?.getText() ?? 'void'}` })
        } else if (ts.isGetAccessorDeclaration(m)) {
            if (ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Static)) continue
            out.push({ label: m.name.getText(), type: m.type?.getText() ?? '' })
        } else if (ts.isConstructorDeclaration(m)) {
            // `constructor(readonly result: Compiled, ...)`: parameter properties are members.
            for (const p of m.parameters) {
                if (ts.getCombinedModifierFlags(p) & (ts.ModifierFlags.Readonly | ts.ModifierFlags.Public)) out.push({ label: p.name.getText(), type: p.type?.getText() ?? '' })
            }
        }
    }
    // Overloads (addEventListener) are one member.
    return out.filter((m, i) => out.findIndex((o) => o.label === m.label) === i)
}

const cache = new Map<PackageName, Map<string, Exported>>()

/** Every export of the package's published entry points (publishConfig.exports), except `./internal`. */
export function exportsOf(pkg: PackageName): Map<string, Exported> {
    const cached = cache.get(pkg)
    if (cached) return cached
    const dir = path.join(SITE, 'packages', pkg)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { publishConfig: { exports: Record<string, string | { types: string }> } }
    const entries = Object.entries(manifest.publishConfig.exports)
        .filter((e): e is [string, { types: string }] => typeof e[1] === 'object' && e[0] !== './internal')
        .map(([, target]) => path.join(dir, target.types.replace('./dist/', 'src/').replace(/\.d\.ts$/, '.ts')))
    const program = ts.createProgram(entries, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
        skipLibCheck: true,
        noEmit: true,
    })
    const checker = program.getTypeChecker()
    const out = new Map<string, Exported>()
    for (const entry of entries) {
        const source = program.getSourceFile(entry)
        const module = source && checker.getSymbolAtLocation(source)
        if (!module) throw new Error(`${entry}: not a module`)
        for (const exported of checker.getExportsOfModule(module)) {
            const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported
            const declaration = symbol.declarations?.[0]
            if (!declaration || out.has(exported.name)) continue
            const name = exported.name
            if (ts.isFunctionDeclaration(declaration)) {
                const generics = declaration.typeParameters ? `<${declaration.typeParameters.map((t) => t.getText()).join(', ')}>` : ''
                const result = declaration.type?.getText() ?? checker.typeToString(checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(declaration)!))
                out.set(name, { name, kind: 'function', signature: `function ${name}${generics}(${parameters(declaration.parameters, checker)}): ${result}` })
            } else if (ts.isInterfaceDeclaration(declaration)) {
                out.set(name, { name, kind: 'interface', members: membersOf(declaration.members) })
            } else if (ts.isTypeAliasDeclaration(declaration)) {
                const generics = declaration.typeParameters ? `<${declaration.typeParameters.map((t) => t.getText()).join(', ')}>` : ''
                out.set(name, {
                    name,
                    kind: 'type',
                    signature: `type ${name}${generics} = ${declaration.type.getText()}`,
                    members: ts.isTypeLiteralNode(declaration.type) ? membersOf(declaration.type.members) : undefined,
                })
            } else if (ts.isClassDeclaration(declaration)) {
                out.set(name, { name, kind: 'class', members: membersOf(declaration.members) })
            } else if (ts.isVariableDeclaration(declaration)) {
                out.set(name, { name, kind: 'const', signature: declaration.type ? `const ${name}: ${declaration.type.getText()}` : undefined })
            }
        }
    }
    cache.set(pkg, out)
    return out
}

/** An API page's entry: a `### \`name\`` or `### \`name()\`` heading and what stands under it. */
export interface Documented {
    name: string
    call: boolean
    line: number
    /** The first `ts` fence under the heading: the signature. */
    signature?: string
    /** Tables under the heading: the header's cells and the rows' cells, code spans unwrapped. */
    tables: { header: string[]; rows: string[][] }[]
}

export interface ApiPage {
    file: string
    entries: Documented[]
    /** Every name the page writes in a code span (`compile()`, `CompileOptions`), outside its code fences. */
    mentioned: Set<string>
}

const cells = (row: string) =>
    row
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replace(/\\\|/g, '|'))
const unwrap = (cell: string) => (/^`([^`]*)`$/.exec(cell)?.[1] ?? cell).trim()

export function apiPage(pkg: PackageName): ApiPage {
    const file = path.join(PAGES, pkg, 'api.mdx')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const entries: Documented[] = []
    const mentioned = new Set<string>()
    let current: Documented | undefined
    let fence: string[] | undefined
    let fenceLanguage = ''
    let table: Documented['tables'][number] | undefined
    lines.forEach((line, i) => {
        if (fence) {
            if (/^```\s*$/.test(line)) {
                if (current && current.signature === undefined && fenceLanguage === 'ts') current.signature = fence.join('\n')
                fence = undefined
            } else fence.push(line)
            return
        }
        const open = /^```(\w*)/.exec(line)
        if (open) {
            fence = []
            fenceLanguage = open[1]
            table = undefined
            return
        }
        for (const m of line.matchAll(/`([^`]+)`/g)) {
            const name = /^[\w$]+/.exec(m[1].replace(/\\\|/g, '|'))?.[0]
            if (name) mentioned.add(name)
        }
        const heading = /^(#{2,4})\s+(.*)$/.exec(line)
        if (heading) {
            table = undefined
            const named = /^`([\w$]+)(\(\))?`$/.exec(heading[2].trim())
            current = heading[1] === '###' && named ? { name: named[1], call: !!named[2], line: i + 1, tables: [] } : undefined
            if (current) entries.push(current)
            return
        }
        if (/^\s*\|/.test(line)) {
            if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return
            if (!table) {
                table = { header: cells(line), rows: [] }
                current?.tables.push(table)
            } else table.rows.push(cells(line).map(unwrap))
        } else table = undefined
    })
    return { file, entries, mentioned }
}

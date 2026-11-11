// Builds the publishable packages (packages/engine, diagram, trace, embed) into each package's dist/: ES modules, .d.ts and
// source maps, with tsc (the TypeScript API) and packages/<name>/tsconfig.build.json. The site does not need this: it
// imports the TypeScript sources (each package.json's `exports`); `publishConfig` points the packed package at dist/.
//
//   node tools/packages/build.mjs            (pnpm packages:build)
//
// The sources import relative modules without extensions, as Vite allows. Node's ES module loader does not, so the
// build writes the extension into every relative specifier of the emitted JavaScript and declarations ('./parser/ids'
// becomes './parser/ids.js', './sim' './sim/index.js'). A package's imports of another (@sccharts-lab/engine/format)
// resolve to that package's built declarations through its published `exports`, as they will for a consumer, so an
// import of a subpath that is not published fails here. The checks at the end hold every published entry to a file
// in dist/ and to the same module in the development `exports`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { buildEmbedBundle } from './embed-bundle.mjs'

const site = fileURLToPath(new URL('../../', import.meta.url))
const packagesDir = path.join(site, 'packages')
/** Build order: each package after the ones it imports. */
export const PACKAGES = ['engine', 'diagram', 'trace', 'embed']

const manifests = new Map(PACKAGES.map(name => [`@sccharts-lab/${name}`, readManifest(name)]))

function readManifest(name) {
    const dir = path.join(packagesDir, name)
    return { name, dir, json: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) }
}

function fail(message) {
    throw new Error(message)
}

/** The published target of a subpath ('.', './format'): { types, default } relative to the package. */
function publishedEntry(manifest, subpath) {
    const entry = manifest.json.publishConfig?.exports?.[subpath]
    if (!entry) return undefined
    return typeof entry === 'string' ? { default: entry } : entry
}

// ----- Relative specifiers get their extension -----------------------------------------------------------------

const KNOWN_EXTENSION = /\.(m?js|json|css)$/

function withExtension(specifier, fromFile, sourceDir) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier
    if (KNOWN_EXTENSION.test(specifier)) return specifier
    // fromFile is the source .ts; the emitted file mirrors its place under src/.
    const base = path.resolve(path.dirname(fromFile), specifier)
    if (!base.startsWith(sourceDir + path.sep)) fail(`${fromFile}: '${specifier}' leaves the package's src/`)
    if (fs.existsSync(base + '.ts')) return specifier + '.js'
    if (fs.existsSync(path.join(base, 'index.ts'))) return specifier + '/index.js'
    fail(`${fromFile}: cannot resolve '${specifier}'`)
}

function extensionTransformer(sourceDir) {
    return context => {
        const f = context.factory
        return file => {
            if (!ts.isSourceFile(file)) return file
            const fromFile = file.fileName.replace(/\.d\.ts$/, '.ts')
            const literal = node => f.createStringLiteral(withExtension(node.text, fromFile, sourceDir))
            const visit = node => {
                if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                    return f.updateImportDeclaration(node, node.modifiers, node.importClause, literal(node.moduleSpecifier), node.attributes)
                }
                if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                    return f.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, literal(node.moduleSpecifier), node.attributes)
                }
                if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
                    return f.updateCallExpression(node, node.expression, node.typeArguments, [literal(node.arguments[0]), ...node.arguments.slice(1)])
                }
                if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
                    const argument = f.updateLiteralTypeNode(node.argument, literal(node.argument.literal))
                    return f.updateImportTypeNode(node, argument, node.attributes, node.qualifier, ts.visitNodes(node.typeArguments, visit), node.isTypeOf)
                }
                return ts.visitEachChild(node, visit, context)
            }
            return ts.visitEachChild(file, visit, context)
        }
    }
}

// ----- Imports of sibling packages resolve to their published declarations ---------------------------------------

function siblingResolution(specifier) {
    const match = /^(@sccharts-lab\/[^/]+)(\/.+)?$/.exec(specifier)
    const manifest = match && manifests.get(match[1])
    if (!manifest) return undefined
    const subpath = match[2] ? `.${match[2]}` : '.'
    const entry = publishedEntry(manifest, subpath)
    if (!entry?.types) fail(`'${specifier}' is not a published entry of ${match[1]} (publishConfig.exports['${subpath}'])`)
    const file = path.join(manifest.dir, entry.types)
    if (!fs.existsSync(file)) fail(`${file} is missing: build ${match[1]} first`)
    return { resolvedFileName: file, extension: ts.Extension.Dts, isExternalLibraryImport: true }
}

// ----- Build ----------------------------------------------------------------------------------------------------

function formatDiagnostics(diagnostics) {
    return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: f => f,
        getCurrentDirectory: () => site,
        getNewLine: () => '\n',
    })
}

function compile(manifest) {
    const configPath = path.join(manifest.dir, 'tsconfig.build.json')
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => fail(formatDiagnostics([d])) })
    if (parsed.errors.length) fail(formatDiagnostics(parsed.errors))
    const host = ts.createCompilerHost(parsed.options)
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, options) =>
        literals.map(literal => {
            const sibling = siblingResolution(literal.text)
            if (sibling) return { resolvedModule: sibling }
            return ts.resolveModuleName(literal.text, containingFile, options, host, undefined, redirected)
        })
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length) fail(`${manifest.json.name}:\n${formatDiagnostics(diagnostics)}`)
    const sourceDir = path.join(manifest.dir, 'src')
    const transformer = extensionTransformer(sourceDir)
    const result = program.emit(undefined, undefined, undefined, false, { after: [transformer], afterDeclarations: [transformer] })
    if (result.emitSkipped || result.diagnostics.length) fail(`${manifest.json.name}:\n${formatDiagnostics(result.diagnostics)}`)
}

/** Published entries the build makes rather than compiles: they have no twin in src/. */
const GENERATED = new Set(['./fonts.css', './embed.min.js'])

/** embed: <sccharts-lab-chart> as one script for a script tag or a CDN, the very build the site serves as /embed.js. */
async function buildEmbedScript(manifest) {
    fs.writeFileSync(path.join(manifest.dir, 'dist/embed.min.js'), await buildEmbedBundle(path.join(manifest.dir, 'src/loader.ts')))
}

/** diagram: its stylesheet, and the fonts its text is measured in (fonts.css, self-hosted). */
function copyDiagramAssets(manifest) {
    const dist = path.join(manifest.dir, 'dist')
    fs.copyFileSync(path.join(manifest.dir, 'src/diagram.css'), path.join(dist, 'diagram.css'))
    fs.mkdirSync(path.join(dist, 'fonts'))
    const faces = []
    for (const font of ['atkinson-hyperlegible-next', 'atkinson-hyperlegible-mono']) {
        const pkg = path.join(site, 'node_modules/@fontsource-variable', font)
        // index.css: the upright variable faces (weights 200 to 800), latin and latin-ext, as the site loads them.
        const css = fs.readFileSync(path.join(pkg, 'index.css'), 'utf8')
        for (const [, file] of css.matchAll(/url\(\.\/files\/([^)]+)\)/g)) {
            fs.copyFileSync(path.join(pkg, 'files', file), path.join(dist, 'fonts', file))
        }
        fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(dist, 'fonts', `${font}.LICENSE.txt`))
        const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version
        faces.push(`/* ${font} from @fontsource-variable/${font} ${version} (SIL Open Font License 1.1: fonts/${font}.LICENSE.txt) */\n`
            + css.replaceAll('url(./files/', 'url(./fonts/').trim())
    }
    fs.writeFileSync(path.join(dist, 'fonts.css'), [
        '/* The fonts @sccharts-lab/diagram measures its text in (font-metrics.ts). Load this with diagram.css unless the',
        '   page already has Atkinson Hyperlegible Next and Mono as "... Variable" families (as @fontsource-variable names them). */',
        ...faces,
        '',
    ].join('\n'))
}

// ----- Checks ---------------------------------------------------------------------------------------------------

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) yield* walk(full)
        else yield full
    }
}

/** The development target of a subpath: an exact key, else the first matching pattern ('./*'). */
function developmentTarget(manifest, subpath) {
    const exports = manifest.json.exports
    if (typeof exports[subpath] === 'string') return exports[subpath]
    for (const [key, target] of Object.entries(exports)) {
        if (!key.includes('*')) continue
        const [prefix, suffix] = key.split('*')
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
            return target.replace('*', subpath.slice(prefix.length, subpath.length - suffix.length))
        }
    }
    return undefined
}

/** Every emitted specifier is relative with an extension, a published entry of a sibling, or a dependency. */
function checkSpecifiers(manifest) {
    const json = manifest.json
    const allowed = new Set([...Object.keys(json.dependencies ?? {}), ...Object.keys(json.peerDependencies ?? {})])
    const dist = path.join(manifest.dir, 'dist')
    for (const file of walk(dist)) {
        if (!/\.(js|d\.ts)$/.test(file)) continue
        const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true)
        for (const { fileName: specifier } of importedFiles) {
            if (specifier.startsWith('.')) {
                const target = path.resolve(path.dirname(file), file.endsWith('.d.ts') ? specifier.replace(/\.js$/, '.d.ts') : specifier)
                if (!target.startsWith(dist + path.sep) || !fs.existsSync(target)) fail(`${file}: '${specifier}' is not a file of dist/`)
                continue
            }
            const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
            if (!allowed.has(name)) fail(`${file}: imports '${specifier}', which is not a dependency of ${json.name}`)
            const sibling = manifests.get(name)
            if (sibling && !publishedEntry(sibling, specifier === name ? '.' : `.${specifier.slice(name.length)}`)) {
                fail(`${file}: '${specifier}' is not a published entry of ${name}`)
            }
        }
    }
}

/** Every published entry exists in dist/ and is the built twin of the same subpath's development module. */
function checkEntries(manifest) {
    const published = manifest.json.publishConfig?.exports ?? fail(`${manifest.json.name}: no publishConfig.exports`)
    for (const [subpath, entry] of Object.entries(published)) {
        if (subpath === './package.json') continue
        const targets = typeof entry === 'string' ? { default: entry } : entry
        for (const target of Object.values(targets)) {
            if (!fs.existsSync(path.join(manifest.dir, target))) fail(`${manifest.json.name}: ${subpath} -> ${target} does not exist`)
        }
        const dev = developmentTarget(manifest, subpath)
        const built = targets.default.replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts')
        if (!GENERATED.has(subpath) && dev !== built) {
            fail(`${manifest.json.name}: '${subpath}' is ${targets.default} when published but ${dev ?? 'missing'} in development (expected ${built})`)
        }
    }
}

export async function build(names = PACKAGES) {
    for (const name of names) {
        const manifest = manifests.get(`@sccharts-lab/${name}`)
        const started = Date.now()
        fs.rmSync(path.join(manifest.dir, 'dist'), { recursive: true, force: true })
        compile(manifest)
        if (name === 'diagram') copyDiagramAssets(manifest)
        if (name === 'embed') await buildEmbedScript(manifest)
        checkSpecifiers(manifest)
        checkEntries(manifest)
        console.log(`${manifest.json.name}: dist/ in ${Date.now() - started} ms`)
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        await build(process.argv.slice(2).length ? process.argv.slice(2) : PACKAGES)
    } catch (error) {
        console.error(error.message)
        process.exit(1)
    }
}

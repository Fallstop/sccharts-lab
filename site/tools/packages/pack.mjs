// Builds the packages and packs each into a tarball, as `pnpm publish` would (publishConfig applied, workspace:
// versions replaced), then checks what each tarball holds. The release workflow publishes exactly these files.
//
//   node tools/packages/pack.mjs [--out <dir>] [--no-build]      (pnpm packages:pack; default out: packages/tarballs)

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, PACKAGES } from './build.mjs'

const site = fileURLToPath(new URL('../../', import.meta.url))
const repoLicense = fs.readFileSync(path.join(site, '../LICENSE'), 'utf8')

/** What a tarball must not hold. */
const FORBIDDEN = [
    [/(^|\/)src\//, 'TypeScript sources'],
    [/\.test\.|test-fixtures/, 'tests'],
    [/\.(sctx|oracle\.json|scenario\.json)$/, 'example charts and recordings'],
    [/tsconfig/, 'build configuration'],
]
/** Upper bounds, so that an accident (a fixture directory, a doubled build) shows. */
const MAX_PACKED = 2_000_000
const MAX_UNPACKED = 8_000_000

function fail(message) {
    throw new Error(message)
}

function checkTarball(name, dir, tarball, files) {
    const paths = files.map(f => f.path)
    for (const p of paths) {
        for (const [pattern, what] of FORBIDDEN) if (pattern.test(p)) fail(`${name}: ${p} (${what}) is in the tarball`)
    }
    for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
        if (!paths.includes(required)) fail(`${name}: ${required} is missing from the tarball`)
    }
    if (fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8') !== repoLicense) fail(`${name}: LICENSE differs from the repository's`)
    let unpacked = 0
    for (const p of paths) {
        const file = path.join(dir, p)
        unpacked += fs.statSync(file).size
        if (p.endsWith('.js') && !paths.includes(p.replace(/\.js$/, '.d.ts'))) fail(`${name}: ${p} has no declarations`)
        if (p.endsWith('.js.map')) {
            // Source maps carry their sources: the tarball has no src/.
            const map = JSON.parse(fs.readFileSync(file, 'utf8'))
            if (!map.sourcesContent || map.sourcesContent.length !== map.sources.length || map.sourcesContent.some(s => typeof s !== 'string')) {
                fail(`${name}: ${p} points at sources the tarball does not have`)
            }
        }
    }
    const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    if (JSON.stringify(manifest).includes('workspace:')) fail(`${name}: the packed package.json still has workspace: versions`)
    if (JSON.stringify(manifest.exports).includes('/src/')) fail(`${name}: the packed exports point at src/`)
    const packed = fs.statSync(tarball).size
    if (packed > MAX_PACKED || unpacked > MAX_UNPACKED) fail(`${name}: ${packed} bytes packed, ${unpacked} unpacked: more than expected`)
    return { name, file: tarball, files: paths.length, packed, unpacked, manifest }
}

/** Packs every package into `out`; returns per package: tarball path, file count, sizes, packed manifest. */
export function pack({ out = path.join(site, 'packages/tarballs'), skipBuild = false } = {}) {
    if (!skipBuild) build()
    fs.mkdirSync(out, { recursive: true })
    const results = []
    for (const name of PACKAGES) {
        const dir = path.join(site, 'packages', name)
        if (!fs.existsSync(path.join(dir, 'dist/index.js'))) fail(`${dir}/dist is missing: run pnpm packages:build`)
        const json = execFileSync('pnpm', ['pack', '--pack-destination', out, '--json'], { cwd: dir, encoding: 'utf8' })
        const { name: pkg, filename, files } = JSON.parse(json)
        results.push(checkTarball(pkg, dir, filename, files))
    }
    return results
}

export function kB(bytes) {
    return `${(bytes / 1000).toFixed(1)} kB`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2)
    const outIndex = args.indexOf('--out')
    try {
        const results = pack({ out: outIndex >= 0 ? path.resolve(args[outIndex + 1]) : undefined, skipBuild: args.includes('--no-build') })
        for (const r of results) console.log(`${r.name}@${r.manifest.version}: ${r.files} files, ${kB(r.packed)} packed, ${kB(r.unpacked)} unpacked -> ${r.file}`)
    } catch (error) {
        console.error(error.message)
        process.exit(1)
    }
}

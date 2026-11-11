// Builds the packages and packs each into a tarball, as `pnpm publish` would (publishConfig applied, workspace:
// versions replaced), then checks what each tarball holds. The release workflow publishes exactly these files.
//
//   node tools/packages/pack.mjs [--out <dir>] [--no-build] [--version <x.y.z>]
//
// (pnpm packages:pack; default out: packages/tarballs). --version fails unless every package has that version (the
// release workflow passes its tag's).

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
        // A module has declarations; a .min.js is a script for a script tag (embed.min.js).
        if (p.endsWith('.js') && !p.endsWith('.min.js') && !paths.includes(p.replace(/\.js$/, '.d.ts'))) fail(`${name}: ${p} has no declarations`)
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

/** The packages are released together: one version for all (the peer dependencies on the engine pin it exactly). */
export function checkVersions(expected) {
    const versions = PACKAGES.map(name => JSON.parse(fs.readFileSync(path.join(site, 'packages', name, 'package.json'), 'utf8')).version)
    if (new Set(versions).size !== 1) fail(`the packages have different versions: ${PACKAGES.map((n, i) => `${n} ${versions[i]}`).join(', ')}`)
    if (expected !== undefined && versions[0] !== expected) fail(`the packages are at ${versions[0]}, not ${expected}`)
    return versions[0]
}

/** Packs every package into `out`; returns per package: tarball path, file count, sizes, packed manifest. */
export async function pack({ out = path.join(site, 'packages/tarballs'), skipBuild = false, version } = {}) {
    checkVersions(version)
    if (!skipBuild) await build()
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
    const option = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
    try {
        const out = option('--out')
        const results = await pack({ out: out && path.resolve(out), skipBuild: args.includes('--no-build'), version: option('--version') })
        for (const r of results) console.log(`${r.name}@${r.manifest.version}: ${r.files} files, ${kB(r.packed)} packed, ${kB(r.unpacked)} unpacked -> ${r.file}`)
    } catch (error) {
        console.error(error.message)
        process.exit(1)
    }
}

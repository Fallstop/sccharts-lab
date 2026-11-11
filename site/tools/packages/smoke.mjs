// Consumer smoke test of the publishable packages: packs them (tools/packages/pack.mjs), installs the tarballs with npm
// into a fresh project (no workspace links), and there
//   (a) runs a Node ES module script with all three (tools/packages/smoke/node-check.mjs: ABRO against KIELER's
//       recording, its C code through gcc, its diagram, its trace in every format);
//   (b) type-checks a TypeScript consumer (smoke/consumer.ts) with moduleResolution bundler and node16;
//   (c) bundles a browser app with Vite (smoke/web: engine and diagram, ELK on the main thread and in a Web Worker)
//       and loads it in headless Chromium: it must draw, step and highlight ABRO, render text exactly as wide as
//       the layout measured it, and log no console errors;
// then reports the minified and gzipped size of each package's main entry in a bundle.
//
//   node tools/packages/smoke.mjs [--dir <dir>] [--no-build] [--version <x.y.z>]       (pnpm packages:smoke)
//
// The tarballs stay in <dir>/tarballs: the release workflow publishes those.
//
// Needs the npm registry (the project installs elkjs, TypeScript and Vite), gcc for the C check (skipped without it)
// and Playwright's Chromium (tools/chromium.mjs). The project stays in <dir> (default: a new temporary directory).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { launchChromium } from '../chromium.mjs'
import { kB, pack } from './pack.mjs'

const site = fileURLToPath(new URL('../../', import.meta.url))
const template = fileURLToPath(new URL('./smoke/', import.meta.url))
const ABRO = path.join(site, 'src/examples/learn/concurrency/abro')

const args = process.argv.slice(2)
const dirIndex = args.indexOf('--dir')
const dir = dirIndex >= 0 ? path.resolve(args[dirIndex + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-lab-smoke-'))
const consumer = path.join(dir, 'consumer')

// The consumer uses the site's versions of TypeScript, Vite (Astro's) and the Node types.
const siteRequire = createRequire(path.join(site, 'package.json'))
const versionOf = name => (name === 'vite' ? createRequire(siteRequire.resolve('astro/package.json')) : siteRequire)(`${name}/package.json`).version

function run(command, commandArgs, options = {}) {
    return execFileSync(command, commandArgs, { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function fail(message) {
    throw new Error(message)
}

function step(title) {
    console.log(`\n== ${title}`)
}

// ----- A fresh project with the tarballs ----------------------------------------------------------------------------

function createProject(tarballs) {
    fs.rmSync(consumer, { recursive: true, force: true })
    fs.mkdirSync(path.join(consumer, 'web'), { recursive: true })
    const dependencies = Object.fromEntries(tarballs.map(t => [t.name, `file:${path.relative(consumer, t.file)}`]))
    // The worker setup imports elkjs itself, so the app depends on it (the version the diagram package pins).
    dependencies.elkjs = tarballs.find(t => t.name === '@sccharts-lab/diagram').manifest.dependencies.elkjs
    const manifest = {
        name: 'sccharts-lab-packages-smoke',
        private: true,
        type: 'module',
        dependencies,
        devDependencies: { typescript: versionOf('typescript'), vite: versionOf('vite'), '@types/node': versionOf('@types/node') },
    }
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
    for (const file of ['node-check.mjs', 'consumer.ts', 'web/index.html', 'web/main.ts']) fs.copyFileSync(path.join(template, file), path.join(consumer, file))
    for (const target of ['abro.sctx', 'web/abro.sctx']) fs.copyFileSync(`${ABRO}.sctx`, path.join(consumer, target))
    fs.copyFileSync(`${ABRO}.oracle.json`, path.join(consumer, 'abro.oracle.json'))
    const compilerOptions = { target: 'ES2022', lib: ['ES2023', 'DOM', 'DOM.Iterable'], strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }
    const tsconfig = (module, moduleResolution) => JSON.stringify({ compilerOptions: { ...compilerOptions, module, moduleResolution }, files: ['consumer.ts'] }, null, 2)
    fs.writeFileSync(path.join(consumer, 'tsconfig.bundler.json'), tsconfig('ESNext', 'Bundler'))
    fs.writeFileSync(path.join(consumer, 'tsconfig.node16.json'), tsconfig('Node16', 'Node16'))
    fs.writeFileSync(path.join(consumer, 'vite.config.mjs'), "export default { root: 'web', base: './', logLevel: 'warn', build: { outDir: '../web-dist', emptyOutDir: true } }\n")
}

// ----- (c) the browser app ------------------------------------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }

function serve(root) {
    const server = http.createServer((request, response) => {
        const file = path.join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/\/$/, '/index.html'))
        if (!file.startsWith(root) || !fs.existsSync(file)) {
            response.writeHead(404).end()
            return
        }
        response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file))
    })
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function browserCheck() {
    run(path.join(consumer, 'node_modules/.bin/vite'), ['build'])
    const root = path.join(consumer, 'web-dist')
    const server = await serve(root)
    const browser = await launchChromium()
    const problems = []
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
        page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') problems.push(`console ${message.type()}: ${message.text()}`) })
        page.on('pageerror', error => problems.push(`page error: ${error.message}`))
        page.on('requestfailed', request => problems.push(`request failed: ${request.url()}`))
        page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`) })
        await page.goto(`http://127.0.0.1:${server.address().port}/`)
        await page.waitForFunction(() => window.smoke, undefined, { timeout: 60_000 })
        const smoke = await page.evaluate(() => window.smoke)
        await page.screenshot({ path: path.join(dir, 'browser.png'), fullPage: true })
        return { smoke, problems }
    } finally {
        await browser.close()
        server.close()
    }
}

function assertBrowser({ smoke, problems }) {
    const fail = message => { throw new Error(`browser: ${message}\n${JSON.stringify({ smoke, problems }, null, 2)}`) }
    if (!smoke.ok) fail(smoke.error)
    if (problems.length) fail('console errors or failed requests')
    if (!smoke.sameLayout) fail('the worker layout differs from the main-thread one')
    if (JSON.stringify(smoke.outputs) !== '[false,false,true]') fail('wrong outputs')
    if (!smoke.active.includes('ABRO.ABO.Done') || !smoke.taken.length) fail('no highlights')
    if (smoke.stroke === 'rgb(190, 190, 190)') fail('diagram.css does not style the active state')
    if (!smoke.fonts.every(Boolean) || !smoke.family.includes('Atkinson Hyperlegible Next Variable')) fail('the diagram fonts did not load')
    if (smoke.worstWidthError > 0.1) fail(`text renders up to ${smoke.worstWidthError} px wider or narrower than measured`)
}

// ----- Sizes: each package's main entry, minified and gzipped, in a Vite bundle -------------------------------------

const SIZE_SCRIPT = `
import { build } from 'vite'
import zlib from 'node:zlib'
import fs from 'node:fs'
const out = {}
for (const name of ['engine', 'diagram', 'trace']) {
    fs.mkdirSync('size', { recursive: true })
    fs.writeFileSync(\`size/\${name}.js\`, \`export * from '@sccharts-lab/\${name}'\\n\`)
    const [result] = [await build({
        configFile: false, logLevel: 'silent',
        build: {
            write: false, minify: true,
            lib: { entry: \`size/\${name}.js\`, formats: ['es'], fileName: name },
            rollupOptions: { external: name === 'engine' ? [] : [/^@sccharts-lab\\/engine/] },
        },
    })].flat()
    out[name] = result.output.filter(c => c.type === 'chunk').map(c => ({
        file: c.fileName, entry: c.isEntry, bytes: Buffer.byteLength(c.code), gzip: zlib.gzipSync(c.code, { level: 9 }).length,
    }))
}
console.log(JSON.stringify(out))
`

function sizes() {
    fs.writeFileSync(path.join(consumer, 'size.mjs'), SIZE_SCRIPT)
    return JSON.parse(run('node', ['size.mjs']).trim().split('\n').pop())
}

// ----- Run ----------------------------------------------------------------------------------------------------------

async function main() {
    step(`Pack (into ${path.join(dir, 'tarballs')})`)
    const version = args.includes('--version') ? args[args.indexOf('--version') + 1] : undefined
    const tarballs = pack({ out: path.join(dir, 'tarballs'), skipBuild: args.includes('--no-build'), version })
    for (const t of tarballs) console.log(`${t.name}@${t.manifest.version}: ${t.files} files, ${kB(t.packed)} packed, ${kB(t.unpacked)} unpacked`)

    step(`npm install in ${consumer}`)
    createProject(tarballs)
    const started = Date.now()
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'])
    const installed = JSON.parse(run('npm', ['ls', '--json', '--all']))
    const engineCopies = run('npm', ['ls', '@sccharts-lab/engine', '--all', '--parseable']).trim().split('\n').filter(Boolean)
    if (engineCopies.length !== 1) throw new Error(`@sccharts-lab/engine is installed ${engineCopies.length} times`)
    console.log(`installed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${Object.keys(installed.dependencies).join(', ')}`)

    step('(a) Node: compile, simulate against KIELER, gcc, diagram, traces')
    const node = JSON.parse(run('node', ['node-check.mjs']).trim())
    console.log(`${node.ticks} ticks equal to KIELER's recording; C: ${node.gcc ? `gcc, ${node.cTicks} ticks equal to the engine` : 'no gcc, skipped'}; SVG ${node.svgBytes} bytes (standalone file: ${path.join(consumer, 'abro.svg')}); traces in 4 formats replayed without a mismatch`)
    console.log(`tick 3: ${node.tick3.join(' ')}`)

    // The README quick starts, as published: the first js block of each package's README.
    for (const name of ['engine', 'diagram', 'trace']) {
        const readme = fs.readFileSync(path.join(consumer, 'node_modules/@sccharts-lab', name, 'README.md'), 'utf8')
        const code = /```js\n([\s\S]*?)```/.exec(readme)?.[1] ?? fail(`${name}: no js block in the README`)
        fs.writeFileSync(path.join(consumer, `readme-${name}.mjs`), code)
        run('node', [`readme-${name}.mjs`])
    }
    console.log('the quick starts of the three READMEs run')

    step('(b) TypeScript: moduleResolution bundler and node16, skipLibCheck off')
    for (const config of ['tsconfig.bundler.json', 'tsconfig.node16.json']) {
        let output = ''
        try {
            run(path.join(consumer, 'node_modules/.bin/tsc'), ['-p', config, '--pretty', 'false'])
        } catch (error) {
            output = `${error.stdout}${error.stderr}`
        }
        // Errors in other packages' declarations are theirs (elkjs's elk-api.d.ts fails strict mode); ours and the
        // consumer's must be none.
        const errors = output.split('\n').filter(line => /error TS\d+/.test(line))
        const foreign = errors.filter(line => line.startsWith('node_modules/') && !line.startsWith('node_modules/@sccharts-lab/'))
        const own = errors.filter(line => !foreign.includes(line))
        if (own.length || (!errors.length && output.trim())) throw new Error(`${config}:\n${output}`)
        console.log(`${config}: no errors in @sccharts-lab's declarations or the consumer${foreign.length ? ` (${foreign.length} in other packages': ${foreign.join('; ')})` : ''}`)
    }

    step('(c) Browser: Vite bundle in headless Chromium')
    const browser = await browserCheck()
    assertBrowser(browser)
    const s = browser.smoke
    console.log(`drawn twice (main thread, Web Worker: same layout ${s.sameLayout}); O over 3 ticks ${JSON.stringify(s.outputs)}; active ${s.active.join(', ')}; ${s.measured} text runs within ${s.worstWidthError.toFixed(3)} px of the layout's widths; no console errors (screenshot: ${path.join(dir, 'browser.png')})`)
    const assets = fs.readdirSync(path.join(consumer, 'web-dist/assets')).map(file => {
        const bytes = fs.readFileSync(path.join(consumer, 'web-dist/assets', file))
        return `${file} ${kB(bytes.length)} (${kB(zlibSize(bytes))} gzipped)`
    })
    console.log(`app bundle: ${assets.join('; ')}`)

    step('Sizes: each package\'s main entry, everything exported, minified (Vite) and gzipped; the engine external to the others')
    for (const [name, chunks] of Object.entries(sizes())) {
        const entry = chunks.filter(c => c.entry)
        const lazy = chunks.filter(c => !c.entry)
        const sum = (list, key) => list.reduce((n, c) => n + c[key], 0)
        console.log(`@sccharts-lab/${name}: ${kB(sum(entry, 'bytes'))} minified, ${kB(sum(entry, 'gzip'))} gzipped`
            + (lazy.length ? `; loaded on demand: ${lazy.map(c => `${c.file} ${kB(c.bytes)} (${kB(c.gzip)} gzipped)`).join(', ')}` : ''))
    }
    console.log(`\nAll checks passed. Project: ${consumer}`)
}

function zlibSize(bytes) {
    return zlib.gzipSync(bytes, { level: 9 }).length
}

main().catch(error => {
    console.error(error.stack ?? error)
    process.exit(1)
})

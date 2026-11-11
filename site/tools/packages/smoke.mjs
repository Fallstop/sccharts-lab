// Consumer smoke test of the publishable packages: packs them (tools/packages/pack.mjs), installs the tarballs with npm
// into a fresh project (no workspace links), and there
//   (a) runs a Node ES module script with engine, diagram and trace (tools/packages/smoke/node-check.mjs: ABRO against KIELER's
//       recording, its C code through gcc, its diagram, its trace in every format);
//   (b) type-checks a TypeScript consumer (smoke/consumer.ts) with moduleResolution bundler and node16;
//   (c) bundles a browser app with Vite (smoke/web: engine and diagram, ELK on the main thread and in a Web Worker)
//       and loads it in headless Chromium: it must draw, step and highlight ABRO, render text exactly as wide as
//       the layout measured it, and log no console errors;
//   (d) loads the embed package's dist/embed.min.js in a host page with a <sccharts-lab-chart>: with a built site
//       (site/dist from `pnpm build`, or --site <dir>) served on another origin, the element must load the embed,
//       get ready and step ABRO, and embed.min.js must be the site's /embed.js byte for byte; without one, only that
//       the script registers the element and frames the right address;
// then reports the minified and gzipped size of each package's main entry in a bundle.
//
//   node tools/packages/smoke.mjs [--dir <dir>] [--no-build] [--version <x.y.z>] [--site <built site>]
//
// (pnpm packages:smoke.) The tarballs stay in <dir>/tarballs: the release workflow publishes those. --site makes the
// live embed check required.
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

// The consumer uses the site's versions of TypeScript, Vite and the Node types.
const siteRequire = createRequire(path.join(site, 'package.json'))
const versionOf = name => siteRequire(`${name}/package.json`).version

// The project's commands run without the npm settings a package manager passes down to this script (pnpm run sets
// npm_config_* variables that make npm leave out devDependencies).
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_|^NODE_ENV$/i.test(key)))

function run(command, commandArgs, options = {}) {
    return execFileSync(command, commandArgs, { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, ...options })
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
    // The browser app as the diagram's README writes it (ELK in a Web Worker, `?url` and `?raw` imports): Vite's client types.
    fs.writeFileSync(path.join(consumer, 'tsconfig.web.json'), JSON.stringify({ compilerOptions: { ...compilerOptions, module: 'ESNext', moduleResolution: 'Bundler', types: ['vite/client'] }, files: ['web/main.ts'] }, null, 2))
    fs.writeFileSync(path.join(consumer, 'vite.config.mjs'), "export default { root: 'web', base: './', logLevel: 'warn', build: { outDir: '../web-dist', emptyOutDir: true } }\n")
}

// ----- (c) the browser app ------------------------------------------------------------------------------------------

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain',
    '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.sctx': 'text/plain',
}

/** The rules of a `_headers` file (Cloudflare's format): a path pattern (`*` matches anything), then indented
 *  `Name: value` lines, or `! Name` to drop a header an earlier rule set. */
function headerRules(root) {
    const file = path.join(root, '_headers')
    if (!fs.existsSync(file)) return []
    const rules = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim() || line.trim().startsWith('#')) continue
        if (!/^\s/.test(line)) rules.push({ match: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), set: [] })
        else rules.at(-1)?.set.push(line.trim())
    }
    return rules
}

/** A static server for a built site: `/x/` and `/x` find `/x/index.html` (or `/x.html`), as a static host does, with
 *  the headers of the site's `_headers` (what Cloudflare sends; the embed in a sandboxed frame depends on them). */
function serve(root) {
    const rules = headerRules(root)
    const server = http.createServer((request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname)
        const file = [pathname, path.join(pathname, 'index.html'), `${pathname}.html`]
            .map(p => path.join(root, p))
            .find(f => f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile())
        if (!file) {
            response.writeHead(404).end()
            return
        }
        const headers = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }
        for (const rule of rules) {
            if (!rule.match.test(pathname)) continue
            for (const line of rule.set) {
                if (line.startsWith('!')) delete headers[line.slice(1).trim().toLowerCase()]
                else headers[line.slice(0, line.indexOf(':')).trim().toLowerCase()] = line.slice(line.indexOf(':') + 1).trim()
            }
        }
        response.writeHead(200, headers).end(fs.readFileSync(file))
    })
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function watch(page, problems) {
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') problems.push(`console ${message.type()}: ${message.text()}`) })
    page.on('pageerror', error => problems.push(`page error: ${error.message}`))
    page.on('requestfailed', request => problems.push(`request failed: ${request.url()}`))
    page.on('response', response => { if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`) })
}

async function browserCheck() {
    run(path.join(consumer, 'node_modules/.bin/vite'), ['build'])
    const root = path.join(consumer, 'web-dist')
    const server = await serve(root)
    const browser = await launchChromium()
    const problems = []
    try {
        const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
        watch(page, problems)
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

// ----- (d) the embed's script tag ----------------------------------------------------------------------------------

/** The built site to embed from: --site (required then), else site/dist when it has the embed. */
function builtSite() {
    const given = args.includes('--site') ? path.resolve(args[args.indexOf('--site') + 1]) : undefined
    const dist = given ?? path.join(site, 'dist')
    const complete = ['embed/index.html', 'embed.js'].every(f => fs.existsSync(path.join(dist, f)))
    if (given && !complete) fail(`${given} is not a built site with the embed (run pnpm build)`)
    return complete ? dist : undefined
}

async function embedCheck() {
    const script = fs.readFileSync(path.join(consumer, 'node_modules/@sccharts-lab/embed/dist/embed.min.js'))
    const siteDir = builtSite()
    if (siteDir && !script.equals(fs.readFileSync(path.join(siteDir, 'embed.js')))) {
        fail(`dist/embed.min.js differs from ${path.join(siteDir, 'embed.js')}: the site's build is older than the package (run pnpm build)`)
    }
    // The host page on one origin (127.0.0.1), the site on another (localhost). Without a built site, a blank page
    // stands in for /embed/.
    const hostRoot = path.join(consumer, 'embed-host')
    fs.rmSync(hostRoot, { recursive: true, force: true })
    fs.mkdirSync(path.join(hostRoot, 'vendor'), { recursive: true })
    fs.writeFileSync(path.join(hostRoot, 'vendor/embed.min.js'), script)
    const siteRoot = siteDir ?? path.join(consumer, 'embed-stub')
    if (!siteDir) {
        fs.mkdirSync(path.join(siteRoot, 'embed'), { recursive: true })
        fs.writeFileSync(path.join(siteRoot, 'embed/index.html'), '<!doctype html><title>stub</title>')
    }
    const host = await serve(hostRoot)
    const siteServer = await serve(siteRoot)
    const base = `http://localhost:${siteServer.address().port}/`
    // A copy of the script not named /embed.js takes its embeds from data-base (else from sccharts.jmw.nz).
    fs.writeFileSync(path.join(hostRoot, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Host</title>
<script src="vendor/embed.min.js" data-base="${base}"></script></head><body>
<sccharts-lab-chart id="abro" example="learn/concurrency/abro" view="sim" loading="eager"></sccharts-lab-chart>
<script>
  window.embedSmoke = (async () => {
    const chart = document.getElementById('abro')
    // The element frames the embed once the page has loaded.
    const frame = () => chart.shadowRoot?.querySelector('iframe')
    for (let i = 0; i < 100 && !frame(); i++) await new Promise(resolve => setTimeout(resolve, 50))
    const result = { defined: !!customElements.get('sccharts-lab-chart'), frame: frame()?.src }
    if (${!!siteDir}) {
      const ready = await chart.ready
      const ticks = []
      for (const inputs of [{ A: false, B: false, R: false }, { A: true }, { A: false, B: true }]) ticks.push(await chart.step(inputs))
      Object.assign(result, { view: ready.view, ok: ready.compiled?.ok, outputs: ticks.map(t => t.values.O), active: ticks[2].active })
    }
    return result
  })().catch(error => ({ error: String(error) }))
</script></body></html>`)
    // The same element inside a frame sandboxed as course platforms do (no allow-same-origin: no web origin there, and
    // none in the embed it frames), with a chart of its own: it must load, take the chart and step it.
    const inner = `<!doctype html><meta charset="utf-8"><script src="vendor/embed.min.js" data-base="${base}"></script>
<sccharts-lab-chart id="mine" view="sim" loading="eager"><pre>scchart Mine {
  input bool press
  output bool on = false
  initial state Off
    if press do on = true go to On
  state On
}</pre></sccharts-lab-chart>
<script>
  window.embedSmoke = (async () => {
    const chart = document.getElementById('mine')
    const ready = await chart.ready
    const ticks = []
    for (const inputs of [{ press: false }, { press: true }]) ticks.push(await chart.step(inputs))
    return { origin: self.origin, chart: ready.compiled?.chart, on: ticks.map(t => t.values.on) }
  })().catch(error => ({ error: String(error) }))
</script>`
    fs.writeFileSync(path.join(hostRoot, 'sandboxed.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Course page</title></head><body>
<iframe title="Lesson" sandbox="allow-scripts allow-popups" style="width: 900px; height: 700px" srcdoc="${inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></body></html>`)
    const browser = await launchChromium()
    const problems = []
    try {
        if (siteDir) {
            const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
            watch(page, problems)
            await page.goto(`http://127.0.0.1:${host.address().port}/sandboxed.html`)
            const frame = page.frames().find(f => f.url() === 'about:srcdoc')
            // A chart that never gets ready (messages lost to a frame without an origin) fails here, not by hanging.
            const sandboxed = await frame?.evaluate(() => Promise.race([window.embedSmoke, new Promise(resolve => setTimeout(() => resolve({ error: 'not ready within 30 s' }), 30000))]))
            if (!sandboxed || sandboxed.error || sandboxed.origin !== 'null' || sandboxed.chart !== 'Mine' || JSON.stringify(sandboxed.on) !== '[false,true]' || problems.length) {
                fail(`embed in a sandboxed frame: ${JSON.stringify({ sandboxed, problems }, null, 2)}`)
            }
            console.log(`a sandboxed course page (origin ${sandboxed.origin}): ${sandboxed.chart} took its chart and stepped, on ${JSON.stringify(sandboxed.on)}`)
            await page.close()
        }
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
        watch(page, problems)
        await page.goto(`http://127.0.0.1:${host.address().port}/`)
        const result = await page.evaluate(() => window.embedSmoke)
        if (siteDir) await page.screenshot({ path: path.join(dir, 'embed.png'), fullPage: true })
        const bad = message => fail(`embed: ${message}\n${JSON.stringify({ result, problems }, null, 2)}`)
        if (result.error) bad(result.error)
        if (!result.defined) bad('embed.min.js did not register <sccharts-lab-chart>')
        if (result.frame !== `${base}embed/?example=learn/concurrency/abro&height=auto`) bad(`the frame's address is ${result.frame}`)
        if (problems.length) bad('console errors or failed requests')
        if (siteDir && (!result.ok || JSON.stringify(result.outputs) !== '[false,false,true]' || !result.active.includes('ABRO.ABO.Done'))) bad('wrong ticks')
        return { live: !!siteDir, siteDir, result }
    } finally {
        await browser.close()
        host.close()
        siteServer.close()
    }
}

// ----- Sizes: each package's main entry, minified and gzipped, in a Vite bundle -------------------------------------

const SIZE_SCRIPT = `
import { build } from 'vite'
import zlib from 'node:zlib'
import fs from 'node:fs'
const out = {}
for (const name of ['engine', 'diagram', 'trace', 'embed']) {
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
    const tarballs = await pack({ out: path.join(dir, 'tarballs'), skipBuild: args.includes('--no-build'), version })
    for (const t of tarballs) console.log(`${t.name}@${t.manifest.version}: ${t.files} files, ${kB(t.packed)} packed, ${kB(t.unpacked)} unpacked`)

    step(`npm install in ${consumer}`)
    createProject(tarballs)
    const started = Date.now()
    run('npm', ['install', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'])
    const installed = JSON.parse(run('npm', ['ls', '--json', '--all']))
    const engineCopies = run('npm', ['ls', '@sccharts-lab/engine', '--all', '--parseable']).trim().split('\n').filter(Boolean)
    if (engineCopies.length !== 1) throw new Error(`@sccharts-lab/engine is installed ${engineCopies.length} times`)
    console.log(`installed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${Object.keys(installed.dependencies).join(', ')}`)

    step('(a) Node: compile, simulate against KIELER, gcc, diagram, traces')
    const node = JSON.parse(run('node', ['node-check.mjs']).trim())
    console.log(`${node.ticks} ticks equal to KIELER's recording; C: ${node.gcc ? `gcc, ${node.cTicks} ticks equal to the engine` : 'no gcc, skipped'}; SVG ${node.svgBytes} bytes (standalone file: ${path.join(consumer, 'abro.svg')}); traces in 4 formats replayed without a mismatch`)
    console.log(`tick 3: ${node.tick3.join(' ')}`)

    // The README quick starts, as published: the first js block of each package's README.
    for (const name of ['engine', 'diagram', 'trace', 'embed']) {
        const readme = fs.readFileSync(path.join(consumer, 'node_modules/@sccharts-lab', name, 'README.md'), 'utf8')
        const code = /```js\n([\s\S]*?)```/.exec(readme)?.[1] ?? fail(`${name}: no js block in the README`)
        fs.writeFileSync(path.join(consumer, `readme-${name}.mjs`), code)
        run('node', [`readme-${name}.mjs`])
    }
    console.log('the first js block of each README runs (the embed\'s: its options and protocol, no DOM)')

    step('(b) TypeScript: moduleResolution bundler and node16, skipLibCheck off')
    for (const config of ['tsconfig.bundler.json', 'tsconfig.node16.json', 'tsconfig.web.json']) {
        let output = ''
        try {
            run(path.join(consumer, 'node_modules/.bin/tsc'), ['-p', config, '--pretty', 'false'])
        } catch (error) {
            output = `${error.stdout}${error.stderr}`
        }
        // No errors at all, other packages' declarations included: a consumer's default tsc (skipLibCheck off) checks
        // what ours load (the diagram's types are its own, not elkjs's, whose elk-api.d.ts does not type-check).
        if (output.trim()) throw new Error(`${config}:\n${output}`)
        console.log(`${config}: no errors`)
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

    step('(d) Embed: dist/embed.min.js and <sccharts-lab-chart> in a host page')
    const embed = await embedCheck()
    if (embed.live) {
        console.log(`embed.min.js is ${embed.siteDir}/embed.js byte for byte; the element framed ${embed.result.frame}, got ready (view ${embed.result.view}) and stepped ABRO: O ${JSON.stringify(embed.result.outputs)}, active ${embed.result.active.join(', ')}; no console errors (screenshot: ${path.join(dir, 'embed.png')})`)
    } else {
        console.log(`the script registers the element, which frames ${embed.result.frame}; the live check is skipped: no built site (pnpm build, or --site <dir>)`)
    }

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

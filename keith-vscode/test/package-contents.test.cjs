const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { listFiles, PackageManager } = require('@vscode/vsce')

test('packages retain the server, bundled runtime and webview while excluding obsolete builds', async t => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sccharts-package-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
        name: 'sccharts-lab', version: '0.9.6', publisher: 'qinnovate', engines: { vscode: '^1.85.0' },
    }))
    fs.copyFileSync(path.resolve(__dirname, '../.vscodeignore'), path.join(cwd, '.vscodeignore'))
    const shipped = [
        'server/sccharts-lite-server.jar', 'server/runtime-manifest.json',
        'server/jre/bin/java', 'server/jre/lib/modules', 'server/jre/legal/java.base/LICENSE',
        'dist/extension.js', 'dist/extension.js.LICENSE.txt', 'pack/webview.js', 'pack/icons.ttf',
        'scripts/uninstall.cjs', 'syntaxes/sctx.tmLanguage.json',
    ]
    const obsolete = [
        'server/kieler-language-server.jar', 'server/diagnostics.jar', 'server/jetty10/jetty-server.jar',
        'dist/simulation-webview.js', 'dist/verification-webview.js', 'dist/extension.js.map',
        'src/extension.ts', 'tsconfig.webview.json', 'test/test.cjs', 'scripts/build-server.cjs',
    ]
    for (const file of [...shipped, ...obsolete]) {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
        fs.writeFileSync(path.join(cwd, file), 'fixture')
    }
    const files = await listFiles({ cwd, packageManager: PackageManager.None })
    for (const file of shipped) assert.ok(files.includes(file), `Missing runtime file: ${file}`)
    for (const file of obsolete) assert.ok(!files.includes(file), `Obsolete file packaged: ${file}`)
})

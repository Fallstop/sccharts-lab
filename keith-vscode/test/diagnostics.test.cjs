const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')
const createLoader = require('./load-typescript.cjs')
const load = createLoader()
const { mapNativeLocation, arrayCopyFix, utf8ColumnOffset } = load('src/kico/source-mapping.ts')
const uri = 'file:///demo.sctx'

test('embedded C diagnostics map escaped quotes and UTF-8 columns to source offsets', () => {
    const source = '#hostcode-c "\nint probe() { char* p = \\"é\\"; return missing; }\n"\nscchart Demo {}'
    const generatedLine = 'int probe() { char* p = "é"; return missing; }'
    const mapped = mapNativeLocation(uri, source, { generatedLine, column: Buffer.byteLength(generatedLine.slice(0, generatedLine.indexOf('missing'))), label: 'unknown identifier' })
    assert.equal(source.slice(mapped.offset, mapped.offset + mapped.length), 'missing')
    assert.equal(mapped.uri, uri)
})

test('UTF-8 byte columns round down inside a code point and account for surrogate pairs', () => {
    assert.equal(utf8ColumnOffset('éx', 1), 0)
    assert.equal(utf8ColumnOffset('éx', 2), 1)
    assert.equal(utf8ColumnOffset('😀x', 3), 0)
    assert.equal(utf8ColumnOffset('😀x', 4), 2)
})

test('ambiguous host lines and generated names stay in the generated file', () => {
    assert.equal(mapNativeLocation(uri, '#hostcode-c "\nbad();\nbad();\n"', { generatedLine: 'bad();', column: 0 }), undefined)
    assert.equal(mapNativeLocation(uri, 'int x\n', { generatedLine: 'd->_g4 = missing;', column: 8 }), undefined)
    assert.equal(mapNativeLocation(uri, '/*\n#hostcode-c "\nbad();\n"\n*/', { generatedLine: 'bad();', column: 0 }), undefined)
    assert.equal(mapNativeLocation(uri, '// a = b\n', { generatedLine: 'd->a = d->b;', column: 0 }), undefined)
})

test('demo array-copy error maps to its source and offers explicit element copies', () => {
    const source = fs.readFileSync(path.join(__dirname, 'fixtures/broken-demo.sctx'), 'utf8')
    const mapped = mapNativeLocation(uri, source, { generatedLine: '    d->timeout_vals = d->timeout_buf;', column: 20 })
    assert.equal(source.slice(mapped.offset, mapped.offset + mapped.length), 'timeout_vals = timeout_buf')
    const fix = arrayCopyFix(source, mapped)
    assert.equal(fix.split('\n').length, 6)
    assert.match(fix, /timeout_vals\[5\] = timeout_buf\[5\]$/)
    assert.equal(arrayCopyFix(source.replace('int timeout_buf[6]', 'int timeout_buf[5]'), mapped), undefined)
})

test('diagram selection matches the nearest traced action and never another source file', () => {
    const mocked = createLoader({ sprotty: {}, 'sprotty-protocol': {} })
    const { findDiagramElements } = mocked('src-webview/diagram/diagnostics/highlight.ts')
    const model = { id: 'root', children: [{ id: 'transition', trace: 'file:///demo.sctx?20:0-20:40#//@states.0/@transitions.0' }, { id: 'other', trace: 'file:///other.sctx?20:0-20:40#//@states.0/@transitions.0' }] }
    assert.deepEqual(findDiagramElements(model, [['file:///demo.sctx#//@states.0/@transitions.0/@effects.0', 'file:///demo.sctx#//@states.0/@transitions.0']]), ['transition'])
    assert.deepEqual(findDiagramElements(model, [['file:///missing.sctx#//@states.0']]), [])
})

test('highlight waits for source and reapplies locally when a stage switch replaces its element IDs', async () => {
    let notification
    const statuses = [], actions = []
    const { DiagnosticHighlighter } = createLoader({ sprotty: {} })('src-webview/diagram/diagnostics/highlight.ts')
    const highlighter = new DiagnosticHighlighter({ onNotification: (_, handler) => { notification = handler } }, message => statuses.push(message))
    highlighter.connect(() => ({ dispatch: async action => actions.push(action) }))
    highlighter.accept({ kind: 'setModel', newRoot: { id: 'scheduler', children: [] } })
    notification({ traceUris: [[uri + '#action']] })
    assert.equal(actions.length, 0)
    highlighter.accept({ kind: 'updateModel', newRoot: { id: 'source', children: [{ id: 'action', trace: uri + '?1:0-1:4#action' }] } })
    await new Promise(setImmediate)
    assert.deepEqual(actions[0].selectedElementsIDs, ['action'])
    assert.equal(actions[0].kind, 'diagnosticSelect', 'Never forward diagnostic selection to the server')
    assert.equal(actions[1].kind, 'fit')
    assert.match(statuses.at(-1), /Highlighted/)
    highlighter.accept({ kind: 'updateModel', newRoot: { id: 'source', children: [] } })
    await new Promise(setImmediate)
    assert.equal(actions.length, 2)
    highlighter.accept({ kind: 'updateModel', newRoot: { id: 'source', children: [{ id: 'replacement', trace: uri + '?1:0-1:4#action' }] } })
    await new Promise(setImmediate)
    assert.equal(actions[2].kind, 'diagnosticSelect')
    assert.deepEqual(actions[2].selectedElementsIDs, ['replacement'])
    assert.equal(actions[3].kind, 'fit')
    assert.match(statuses.at(-1), /Highlighted/)
    notification({ traceUris: [] })
})

test('failure panel exposes source, explanation and details, disables stale source actions', () => {
    const dom = new JSDOM('<div class="kv-root"><header class="kv-toolbar"></header></div>')
    for (const name of ['document', 'window', 'HTMLElement', 'Event']) global[name] = dom.window[name]
    const ui = createLoader()
    const { DiagnosticView } = ui('src-webview/diagram/diagnostics/view.ts')
    const sent = []
    const view = new DiagnosticView({ onNotification() {}, sendNotification: (_, __, command) => sent.push(command) })
    const issue = { id: '1:0', stage: 'Scheduler', message: 'Circular dependency involving flag.', severity: 'error', code: 'scheduling-cycle', locations: [{ uri, offset: 0, length: 4, label: '<script>flag</script>', traceUris: [uri] }], cycle: [{ from: '_g1', to: '_g2', fromLabel: 'flag = true', toLabel: 'flag = false', reason: 'Concurrent writes require this ordering.', locations: [] }] }
    const report = { id: 1, uri, version: 1, status: 'failed', issues: [issue], rawCount: 48 }
    view.render(report)
    assert.match(view.el.querySelector('[role="alert"]').textContent, /Compilation failed/)
    assert.equal(view.el.querySelector('script'), null)
    assert.match(view.el.querySelector('.kd-cycle').textContent, /flag = true/)
    view.el.querySelector('.kd-sources button').click()
    assert.deepEqual(sent.pop(), { kind: 'source', build: 1, issue: '1:0', location: 0 })
    view.render({ ...report, status: 'stale' })
    assert.equal(view.el.querySelector('.kd-sources button').disabled, true)
    view.render(undefined)
    assert.equal(view.el.hidden, true)
    dom.window.close()
})

test('the preview panel hides and shows warnings with the editor, and says how many it hides', () => {
    const dom = new JSDOM('<div class="kv-root"><header class="kv-toolbar"></header></div>')
    for (const name of ['document', 'window', 'HTMLElement', 'Event']) global[name] = dom.window[name]
    const ui = createLoader()
    const { DiagnosticView } = ui('src-webview/diagram/diagnostics/view.ts')
    const sent = []
    const view = new DiagnosticView({ onNotification() {}, sendNotification: (_, __, command) => sent.push(command) })
    const warning = { id: '2:0', stage: 'Dependency', message: 'Potential instantaneous loop.', severity: 'warning', code: 'instantaneous-loop', locations: [], cycle: [] }
    const report = { id: 2, uri, version: 1, status: 'succeeded', issues: [warning], rawCount: 3 }
    const buttons = () => [...view.el.querySelectorAll('.kd-heading button')].map((button) => button.textContent)
    view.render(report, true)
    assert.match(view.el.querySelector('[role="status"]').textContent, /Compiled with 1 warning/)
    assert.ok(view.el.querySelector('.kd-warnings'), 'the warning list is there')
    assert.deepEqual(buttons(), ['Hide warnings', 'Problems', 'Copy diagnostics'])
    view.el.querySelector('.kd-heading button').click()
    assert.deepEqual(sent.pop(), { kind: 'showWarnings', enabled: false })
    view.render(report, false)
    assert.equal(view.el.hidden, false, 'the panel stays, so the warnings can be brought back from here')
    assert.match(view.el.querySelector('[role="status"]').textContent, /Compiled, 1 warning hidden/)
    assert.equal(view.el.querySelector('.kd-warnings'), null, 'no warning list while hidden')
    assert.deepEqual(buttons(), ['Show warnings', 'Problems', 'Copy diagnostics'])
    view.el.querySelector('.kd-heading button').click()
    assert.deepEqual(sent.pop(), { kind: 'showWarnings', enabled: true })
    // With no warnings there is nothing to toggle.
    view.render({ ...report, issues: [{ ...warning, severity: 'error', stage: 'Scheduler' }] }, false)
    assert.deepEqual(buttons(), ['Problems', 'Copy diagnostics'])
    dom.window.close()
})

test('preview information stays visible independently of warnings and diagnostics can be copied', () => {
    const dom = new JSDOM('<div class="kv-root"><header class="kv-toolbar"></header></div>')
    for (const name of ['document', 'window', 'HTMLElement', 'Event']) global[name] = dom.window[name]
    const { DiagnosticView } = createLoader()('src-webview/diagram/diagnostics/view.ts')
    const sent = []
    const view = new DiagnosticView({ onNotification() {}, sendNotification: (_, __, command) => sent.push(command) })
    const note = { id: '3:0', stage: 'Compiler', message: 'A helpful note.', severity: 'info', code: 'note', locations: [], cycle: [] }
    view.render({ id: 3, uri, version: 1, status: 'succeeded', issues: [note], rawCount: 0 }, false)
    assert.match(view.el.textContent, /Compiled with 1 note/)
    assert.match(view.el.textContent, /A helpful note/)
    const copy = [...view.el.querySelectorAll('.kd-heading button')].find(button => button.textContent === 'Copy diagnostics')
    copy.click()
    assert.deepEqual(sent.pop(), { kind: 'copy', build: 3 })
    dom.window.close()
})

test('synthetic source failures omit compiler-stage navigation while keeping technical details', () => {
    const dom = new JSDOM('<div class="kv-root"><header class="kv-toolbar"></header></div>')
    for (const name of ['document', 'window', 'HTMLElement', 'Event']) global[name] = dom.window[name]
    const { DiagnosticView } = createLoader()('src-webview/diagram/diagnostics/view.ts')
    const view = new DiagnosticView({ onNotification() {}, sendNotification() {} })
    const issue = { id: '4:0', stage: 'Source Validation', message: 'Missing initial state.', severity: 'error', code: 'source-validation', locations: [], cycle: [], snapshotIndex: -1 }
    view.render({ id: 4, uri, version: 1, status: 'failed', issues: [issue], rawCount: 1 })
    const actions = [...view.el.querySelectorAll('.kd-issue .kd-actions button')].map(button => button.textContent)
    assert.deepEqual(actions, ['Technical details'])
    dom.window.close()
})

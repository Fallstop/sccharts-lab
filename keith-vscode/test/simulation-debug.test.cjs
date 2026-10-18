// Client side of the simulation debugger: definitions persist per model, reach the server when a
// simulation starts, step messages update watches and pause a run, and a rewind trims the trace.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

class EventEmitter {
    handlers = new Set()
    event = (handler) => {
        this.handlers.add(handler)
        return { dispose: () => this.handlers.delete(handler) }
    }
    fire(value) { for (const handler of this.handlers) handler(value) }
    dispose() { this.handlers.clear() }
}

function memento() {
    const store = new Map()
    return { get: (key) => store.get(key), update: async (key, value) => { store.set(key, value) }, store }
}

function setup(t, workspaceState = memento()) {
    const commands = new Map()
    const sent = []
    const requests = []
    const notifications = new Map()
    const noop = () => {}
    const messages = { info: [], warning: [], channels: [] }
    const vscode = {
        EventEmitter,
        StatusBarAlignment: { Left: 0 },
        Uri: { parse: (uri) => ({ toString: () => uri, path: new URL(uri).pathname }) },
        commands: {
            registerCommand: (id, handler) => { commands.set(id, handler); return { dispose: noop } },
            executeCommand: async (id, ...args) => commands.get(id)?.(...args),
        },
        window: {
            createOutputChannel: (name) => ({ appendLine: (line) => { messages.channels.push([name, line]) }, show: noop, dispose: noop }),
            createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
            showInformationMessage: async (text) => { messages.info.push(text) },
            showWarningMessage: async (text) => { messages.warning.push(text) },
            showErrorMessage: async () => undefined,
            showQuickPick: async (items) => items[1],
            showInputBox: async () => 'count * 10',
        },
        workspace: {
            onDidChangeTextDocument: () => ({ dispose: noop }),
            openTextDocument: async (uri) => ({ uri, isDirty: false, getText: () => '', save: async () => true }),
        },
    }
    const accept = (list) => ({ accepted: list.map((entry) => ({ id: entry.id, ok: !/bad/.test(entry.expression ?? entry.state ?? ''), message: /bad/.test(entry.expression ?? entry.state ?? '') ? 'Unknown variable bad.' : undefined })) })
    const client = {
        start: async () => {},
        onNotification: (name, handler) => { notifications.set(name, handler); return { dispose: noop } },
        onDidChangeState: new EventEmitter().event,
        sendNotification: async (name, params) => { sent.push({ name, params }) },
        sendRequest: async (name, params) => {
            requests.push({ name, params })
            if (name === 'keith/simulation/setBreakpoints') return accept(params.breakpoints)
            if (name === 'keith/simulation/setWatches') return accept(params.watches)
            if (name === 'keith/simulation/stepBack') return { ok: params.toStep !== 99, message: params.toStep === 99 ? 'no' : undefined, step: params.toStep, replayMs: 1 }
            if (name === 'keith/simulation/states') return { states: [{ name: 'Root', qualified: 'Root', initial: true }, { name: 'Full', qualified: 'Root.Full', initial: false, current: true }] }
            return { successful: true }
        },
    }
    const compiler = {
        newSimulationCommands: new EventEmitter().event,
        compilationStarted: new EventEmitter().event,
        compilationFinished: new EventEmitter().event,
        lastCompiledUri: 'file:///models/counter.sctx',
        compile: async () => {},
    }
    const load = createLoader({ vscode, 'vscode-languageclient/node': { State: { Stopped: 1 } } })
    const { SimulationTableDataProvider } = load('src/simulation/simulation-table-data-provider.ts')
    const settings = { get: (key) => key === 'simulationStepDelay' ? 1 : 'Manual' }
    const sim = new SimulationTableDataProvider(client, compiler, { subscriptions: [], workspaceState }, settings)
    t.after(() => sim.dispose())
    const started = { successful: true, dataPool: { start: false, count: 0 }, propertySet: { input: ['start'], output: ['count'] } }
    const start = async () => { await sim.simulate(); await sim.handleSimulationStarted(started); await new Promise((resolve) => setImmediate(resolve)) }
    return { sim, client, sent, requests, commands, start, notifications, messages, workspaceState, vscode }
}

test('breakpoints and watches persist per model and are sent when the simulation starts', async (t) => {
    const first = setup(t)
    await first.start()
    await first.sim.debugger.addBreakpoint({ state: 'Full' })
    await first.sim.debugger.addBreakpoint({ expression: 'bad > 1' })
    await first.sim.debugger.addWatch('count * 10')
    const breakpoints = first.sim.debugger.breakpoints
    assert.equal(breakpoints.length, 2)
    assert.equal(breakpoints[0].kind, 'state')
    assert.equal(breakpoints[1].error, 'Unknown variable bad.')
    assert.equal(breakpoints[0].error, undefined)
    const stored = first.workspaceState.store.get('keith.simulation.debug:file:///models/counter.sctx')
    assert.equal(stored.breakpoints.length, 2)
    assert.deepEqual(stored.watches.map((watch) => watch.expression), ['count * 10'])
    assert.ok(!('error' in stored.breakpoints[1]), 'server verdicts are not persisted')

    // A new session with the same workspace state sends the definitions as soon as the simulation runs.
    const second = setup(t, first.workspaceState)
    await second.start()
    const set = second.requests.filter((request) => request.name === 'keith/simulation/setBreakpoints')
    assert.equal(set.length, 1)
    assert.deepEqual(set[0].params.breakpoints.map((breakpoint) => breakpoint.state ?? breakpoint.expression), ['Full', 'bad > 1'])
    assert.equal(second.requests.filter((request) => request.name === 'keith/simulation/setWatches')[0].params.watches[0].expression, 'count * 10')
    const state = second.sim.debugger.state(0)
    assert.equal(state.canStepBack, false)
    assert.equal(state.breakpoints[1].error, 'Unknown variable bad.')
    await second.sim.debugger.toggleBreakpoint(state.breakpoints[0].id, false)
    assert.equal(second.workspaceState.store.get('keith.simulation.debug:file:///models/counter.sctx').breakpoints[0].enabled, false)
    await second.sim.debugger.removeBreakpoint(state.breakpoints[1].id)
    await second.sim.debugger.removeWatch(second.sim.debugger.watches[0].id)
    assert.equal(second.sim.debugger.breakpoints.length, 1)
    assert.equal(second.sim.debugger.watches.length, 0)
})

test('step messages carry watch values, a breakpoint pauses a run, and a rewind trims the trace', async (t) => {
    const { sim, start, sent, notifications } = setup(t)
    await start()
    await sim.debugger.addWatch('count * 10')
    await sim.debugger.addBreakpoint({ expression: 'count == 2' })
    const watch = sim.debugger.watches[0]
    const breakpoint = sim.debugger.breakpoints[0]
    sim.handleStepMessage({ values: { start: true, count: 0 }, step: 1, watches: [{ id: watch.id, value: 0 }] })
    sim.handleStepMessage({ values: { start: true, count: 1 }, step: 2, watches: [{ id: watch.id, value: 10 }] })
    assert.equal(sim.debugger.watches[0].value, 10)
    assert.equal(sim.simulationStep, 2)
    assert.equal(sim.debugger.state(2).canStepBack, true)

    // While running, a breakpoint hit stops the run loop.
    const running = sim.setPlaying(true)
    assert.equal(sim.play, true)
    sim.handleStepMessage({
        values: { start: true, count: 2 },
        step: 3,
        watches: [{ id: watch.id, error: 'Division by zero.' }],
        breakpoint: { id: breakpoint.id, kind: 'condition', label: 'count == 2 holds', step: 3 },
    })
    assert.equal(sim.play, false)
    await running
    assert.equal(sim.debugger.paused?.label, 'count == 2 holds')
    assert.equal(sim.debugger.watches[0].error, 'Division by zero.')
    assert.equal(sim.debugger.watches[0].value, undefined)
    assert.deepEqual(sim.simulationData.get('count').data, [0, 1, 2])
    // The paused notification alone stops a run as well; the tick it belongs to still lands in the trace.
    const secondRun = sim.setPlaying(true)
    notifications.get('keith/simulation/paused')({ id: breakpoint.id, kind: 'condition', label: 'again', step: 4 })
    assert.equal(sim.play, false)
    sim.handleStepMessage({ values: { start: true, count: 2 }, step: 4, watches: [] })
    await secondRun
    assert.equal(sim.simulationStep, 4)

    // A run to the next breakpoint is a server-side loop that the next hit ends.
    await sim.runToBreakpoint()
    assert.equal(sim.debugger.runningToBreakpoint, true)
    assert.equal(sent.at(-1).name, 'keith/simulation/runToBreakpoint')
    sim.handleStepMessage({ values: { count: 3 }, step: 5, watches: [] })
    assert.equal(sim.debugger.runningToBreakpoint, true)
    sim.handleStepMessage({ values: { count: 3 }, step: 6, watches: [], breakpoint: { id: breakpoint.id, kind: 'condition', label: 'x', step: 6 } })
    assert.equal(sim.debugger.runningToBreakpoint, false)
    assert.equal(sim.simulationStep, 6)

    // Rewinding: the server's rewound tick replaces the trace beyond the target.
    assert.equal(await sim.stepBack(2), true)
    sim.handleStepMessage({ values: { start: true, count: 1 }, step: 2, watches: [{ id: watch.id, value: 10 }], rewound: true })
    assert.equal(sim.simulationStep, 2)
    assert.deepEqual(sim.simulationData.get('count').data, [0, 1])
    assert.equal(sim.debugger.paused, undefined)
    assert.equal(sim.debugger.watches[0].value, 10)
    assert.equal(sim.valuesForNextStep.get('start'), true)
    // The default rewinds one tick; a refused rewind is reported, not fatal.
    assert.equal(await sim.stepBack(), true)
    assert.equal(await sim.stepBack(99), false)
    assert.equal(sim.phase, 'running')
    assert.equal(await sim.stepBack(-1), false)
})

test('the commands add breakpoints from the server state list and watches from an input box', async (t) => {
    const { sim, start, commands, requests, messages } = setup(t)
    await commands.get('keith-vscode.simulation-add-breakpoint')()
    assert.equal(messages.info.length, 1, 'without a simulation the command explains itself')
    await start()
    await commands.get('keith-vscode.simulation-add-breakpoint')()
    assert.equal(requests.filter((request) => request.name === 'keith/simulation/states').length, 1)
    assert.deepEqual(sim.debugger.breakpoints.map((breakpoint) => breakpoint.state), ['Root.Full'])
    await commands.get('keith-vscode.simulation-add-watch')()
    assert.deepEqual(sim.debugger.watches.map((watch) => watch.expression), ['count * 10'])
    await commands.get('keith-vscode.simulation-run-to-breakpoint')()
    assert.equal(sim.debugger.runningToBreakpoint, true)
    await sim.stopSimulation()
    assert.equal(sim.debugger.runningToBreakpoint, false)
    assert.equal(sim.debugger.breakpoints.length, 1, 'definitions outlive the run')
})

// ---- Webview: toolbar buttons, breakpoint list and rewindable tick headers ----

const { JSDOM } = require('jsdom')

function webview(t) {
    const dom = new JSDOM('<div id="keith-diagram_sprotty_container"></div>', { url: 'https://webview.test' })
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'localStorage']) {
        global[key] = dom.window[key]
    }
    global.CSS = { escape: (value) => value.replaceAll('"', '\\"') }
    global.ResizeObserver = class { observe() {} }
    t.after(() => dom.window.close())
    return createLoader()
}

const variable = () => ({ id: 'count', label: 'count', role: 'output', history: [0, 1, 2], pending: false, internal: false, categories: [] })
const debug = (patch = {}) => ({
    breakpoints: [{ id: 'b1', kind: 'state', state: 'Full', enabled: true }, { id: 'b2', kind: 'condition', expression: 'bad', enabled: true, error: 'Unknown variable bad.' }],
    watches: [{ id: 'w1', expression: 'count * 10', value: 20 }, { id: 'w2', expression: '1 / 0', error: 'Division by zero.' }],
    canStepBack: true,
    runningToBreakpoint: false,
    states: [],
    ...patch,
})
const viewState = (patch = {}) => ({ phase: 'running', canStart: true, modelUri: 'file:///m.sctx', tick: 3, firstTick: 1, playing: false, stepDelay: 200, showInternal: false, variables: [variable()], debug: debug(), ...patch })

test('the toolbar offers Back and the breakpoint list with its count, and disables them while running', (t) => {
    const load = webview(t)
    const { Toolbar } = load('src-webview/diagram/simulation/toolbar.ts')
    const sent = []
    let open = false
    const toolbar = new Toolbar({ send: (command) => sent.push(command), toggleDrawer() {}, drawerOpen: () => false, toggleBreakpoints: () => { open = !open }, breakpointsOpen: () => open })
    document.body.append(toolbar.el)
    toolbar.render(viewState())
    const button = (label) => toolbar.el.querySelector(`button[aria-label="${label}"]`)
    assert.ok(!button('Back').disabled)
    button('Back').click()
    assert.deepEqual(sent.map((command) => command.kind), ['stepBack'])
    assert.equal(button('Continue'), null, 'Continue is the C key, not a button')
    assert.equal(button('Breakpoints (2)').getAttribute('data-control'), 'Breakpoints')
    assert.equal(button('Breakpoints (2)').querySelector('.kv-badge').textContent, '2')
    button('Breakpoints (2)').click()
    assert.equal(open, true)

    toolbar.render(viewState({ debug: debug({ runningToBreakpoint: true }) }))
    assert.ok(button('Back').disabled)
    assert.ok(button('Step').disabled)
    assert.ok(button('Pause'), 'Run turns into Pause while the server steps to a breakpoint')
    toolbar.render(viewState({ debug: debug({ breakpoints: [] }) }))
    assert.equal(button('Breakpoints').querySelector('.kv-badge'), null, 'no badge without breakpoints')
    toolbar.render(viewState({ tick: 0, debug: debug({ canStepBack: false }) }))
    assert.ok(button('Back').disabled)
})

test('the breakpoint panel lists, toggles, removes and adds breakpoints; watches show values and errors', (t) => {
    const load = webview(t)
    const { BreakpointPanel, WatchPanel, renderPauseNotice } = load('src-webview/diagram/simulation/debug.ts')
    const sent = []
    const panel = new BreakpointPanel((command) => sent.push(command))
    document.body.append(panel.el)
    panel.render(viewState({ debug: debug({ paused: { id: 'b1', kind: 'state', label: 'Entered state Full', step: 3 } }) }))
    const items = panel.el.querySelectorAll('li')
    assert.equal(items.length, 2)
    assert.ok(items[0].classList.contains('kv-debug-hit'))
    assert.ok(items[1].classList.contains('kv-debug-error'))
    assert.match(items[1].textContent, /Unknown variable bad/)
    items[0].querySelector('input[type="checkbox"]').click()
    items[1].querySelector('button').click()
    const stateEntry = panel.el.querySelector('input[data-control="bp-state"]')
    stateEntry.value = 'Counting.Tick'
    stateEntry.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const conditionEntry = panel.el.querySelector('input[data-control="bp-condition"]')
    conditionEntry.value = 'count > 1'
    conditionEntry.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.deepEqual(sent, [
        { kind: 'toggleBreakpoint', id: 'b1', enabled: false },
        { kind: 'removeBreakpoint', id: 'b2' },
        { kind: 'addBreakpoint', state: 'Counting.Tick' },
        { kind: 'addBreakpoint', expression: 'count > 1' },
    ])
    assert.equal(stateEntry.value, '', 'the entry clears after adding')

    // The state entry completes against the server's state list: typing filters, Enter takes the first match.
    panel.render(viewState({ debug: debug({ states: [{ name: 'Root', qualified: 'Root.Tick', initial: true }, { name: 'Full', qualified: 'Root.Full' }] }) }))
    const picker = panel.el.querySelector('input[data-control="bp-state"]')
    picker.focus()
    picker.value = 'fu'
    picker.dispatchEvent(new window.Event('input', { bubbles: true }))
    const shown = [...panel.el.querySelectorAll('.kv-combo-item .kv-combo-label')].map((item) => item.textContent)
    assert.deepEqual(shown, ['Root.Full'], 'matches are filtered case-insensitively')
    picker.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.deepEqual(sent.at(-1), { kind: 'addBreakpoint', state: 'Root.Full' })
    assert.equal(picker.value, '', 'the picker resets after adding')
    assert.equal(panel.el.querySelector('.kv-debug-hint'), null, 'no explanatory paragraph')

    // Condition entries complete the word at the caret with the simulation's variables and pre().
    const condition = panel.el.querySelector('input[data-control="bp-condition"]')
    condition.focus()
    condition.value = 'co'
    condition.setSelectionRange(2, 2)
    condition.dispatchEvent(new window.Event('input', { bubbles: true }))
    const offered = [...panel.el.querySelectorAll('.kv-combo-item .kv-combo-label')].map((item) => item.textContent)
    assert.deepEqual(offered, ['count'], 'the variable matching the typed prefix')
    condition.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    condition.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(condition.value, 'count', 'a highlighted suggestion completes the word instead of submitting')
    condition.value = 'count > 1 && pr'
    condition.setSelectionRange(15, 15)
    condition.dispatchEvent(new window.Event('input', { bubbles: true }))
    condition.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    condition.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    assert.equal(condition.value, 'count > 1 && pre(', 'pre() inserts its opening parenthesis')

    const watches = new WatchPanel((command) => sent.push(command))
    document.body.append(watches.el)
    watches.render(viewState())
    const chips = watches.el.querySelectorAll('.kv-watch')
    assert.equal(chips.length, 2)
    assert.match(chips[0].textContent, /count \* 10=20/)
    assert.ok(chips[1].classList.contains('kv-watch-error'))
    assert.equal(chips[1].title, 'Division by zero.')
    chips[1].querySelector('button').click()
    assert.deepEqual(sent.at(-1), { kind: 'removeWatch', id: 'w2' })
    const add = watches.el.querySelector('input')
    add.value = 'pre(count)'
    add.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.deepEqual(sent.at(-1), { kind: 'addWatch', expression: 'pre(count)' })

    assert.equal(renderPauseNotice(debug()), null)
    assert.match(renderPauseNotice(debug({ paused: { id: 'b1', kind: 'state', label: 'Entered state Full', step: 3 } })).textContent, /Paused at tick 3: Entered state Full/)
})

test('earlier tick headers rewind on click and the paused tick is marked', (t) => {
    const load = webview(t)
    const { Timeline } = load('src-webview/diagram/simulation/timeline.ts')
    const sent = []
    const timeline = new Timeline((command) => sent.push(command))
    document.body.append(timeline.el)
    timeline.render(viewState({ debug: debug({ paused: { id: 'b1', kind: 'state', label: 'x', step: 2 } }) }))
    const headers = [...timeline.el.querySelectorAll('th.kv-col-tick')]
    assert.deepEqual(headers.map((header) => header.classList.contains('kv-rewindable')), [true, true, false])
    assert.ok(headers[1].classList.contains('kv-hit'))
    headers[0].click()
    headers[2].click()
    assert.deepEqual(sent, [{ kind: 'stepBack', toStep: 1 }])
    timeline.render(viewState({ playing: true }))
    assert.equal(timeline.el.querySelectorAll('th.kv-rewindable').length, 0, 'no rewinding while ticks run')
})

test('picking a state from the completion list keeps the breakpoint popover open, and ticks leave the list alone', (t) => {
    const load = webview(t)
    const { BreakpointPanel } = load('src-webview/diagram/simulation/debug.ts')
    const sent = []
    const panel = new BreakpointPanel((command) => sent.push(command))
    document.body.append(panel.el)
    const states = [{ name: 'Root', qualified: 'Root.Tick', initial: true }, { name: 'Full', qualified: 'Root.Full' }]
    panel.render(viewState({ debug: debug({ states }) }))
    panel.toggle(true)
    const picker = panel.el.querySelector('input[data-control="bp-state"]')
    picker.focus()
    picker.dispatchEvent(new window.Event('input', { bubbles: true }))
    const items = panel.el.querySelectorAll('.kv-combo-item')
    assert.equal(items.length, 2, 'the list is open')
    // A tick that changes nothing the popover shows must not rebuild it under the open list.
    panel.render(viewState({ tick: 9, debug: debug({ states }) }))
    assert.equal(panel.el.querySelector('input[data-control="bp-state"]'), picker, 'the field is the same element')
    assert.equal(panel.el.querySelectorAll('.kv-combo-item').length, 2, 'the list is still open')
    // Choosing an entry removes it from the list before the document sees the mousedown.
    items[1].querySelector('.kv-combo-label').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }))
    assert.deepEqual(sent.at(-1), { kind: 'addBreakpoint', state: 'Root.Full' })
    assert.equal(panel.isOpen(), true, 'the popover stays open')
    assert.equal(panel.el.hidden, false)
    // A click anywhere else still closes it.
    document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
    assert.equal(panel.isOpen(), false)
})

test('printed lines are kept per tick, logged with their tick, trimmed by a rewind and saved with the trace', async (t) => {
    const { sim, start, messages } = setup(t)
    await start()
    sim.handleStepMessage({ values: { start: true, count: 0 }, step: 1, watches: [], printed: ['hello'] })
    sim.handleStepMessage({ values: { start: true, count: 1 }, step: 2, watches: [] })
    sim.handleStepMessage({ values: { start: true, count: 2 }, step: 3, watches: [], printed: ['a', 'b'] })
    assert.deepEqual(sim.printed, [['hello'], [], ['a', 'b']])
    assert.deepEqual(sim.currentTrace().printed, [['hello'], [], ['a', 'b']])
    const logged = () => messages.channels.filter(([name]) => name === 'SCCharts Printed').map(([, line]) => line)
    assert.deepEqual(logged(), ['--- counter.sctx started ---', '[tick 1] hello', '[tick 3] a', '[tick 3] b'])
    assert.equal(await sim.stepBack(1), true)
    sim.handleStepMessage({ values: { start: true, count: 0 }, step: 1, watches: [], rewound: true })
    assert.deepEqual(sim.printed, [['hello']])
    assert.equal(logged().at(-1), '--- rewound to tick 1 ---')
    sim.handleStepMessage({ values: { start: true, count: 1 }, step: 2, watches: [] })
    // A run that printed nothing saves no printed column.
    assert.deepEqual(sim.currentTrace().printed, [['hello'], []])
    sim.printed = [[], []]
    assert.equal(sim.currentTrace().printed, undefined)
})

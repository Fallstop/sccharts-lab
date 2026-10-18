const assert = require('node:assert/strict')
const { test } = require('node:test')
const { URI } = require('vscode-uri')
const createLoader = require('./load-typescript.cjs')

function event() {
    const listeners = new Set()
    return {
        subscribe: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } },
        fire: () => { for (const listener of listeners) listener() },
    }
}

const first = 'file:///models/first/clock.sctx'
const second = 'file:///models/second/clock.sctx'

function setup(t) {
    const changed = event()
    const executed = []
    const sent = []
    let receive
    const simulation = {
        phase: 'running', play: false, simulationStep: 3, modelUri: first,
        simulationData: new Map([['input', { id: 'input', label: 'Input', input: true, categories: [], data: [1, 2, 3] }]]),
        printed: [],
        valuesForNextStep: new Map([['input', 4]]), changedValuesForNextStep: new Map(),
        onDidChangeViewState: changed.subscribe,
        isBlacklisted: () => false, isInternal: () => false,
        restartSimulation: async () => executed.push(['restart']),
        rebuildSimulation: async () => executed.push(['rebuild']),
        setInputValue: () => executed.push(['setInput']),
        kico: { onDidChangeStage: changed.subscribe, currentStage: () => undefined },
        debugger: { state: () => undefined, runningToBreakpoint: false, pause: async () => executed.push(['pause']) },
    }
    const diagrams = {
        currentUri: URI.parse(first),
        onDidChangeDiagram: changed.subscribe,
        onWebviewNotification: (_, handler) => { receive = handler; return { dispose() {} } },
        sendToDiagram: (_, state) => sent.push(state),
    }
    const settings = { get: (key) => key === 'simulationStepDelay' ? 200 : false, set: async () => {} }
    const load = createLoader({ vscode: {
        Uri: URI,
        commands: { executeCommand: async (...args) => executed.push(args) },
        workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
        window: { showErrorMessage: assert.fail },
    } })
    const { SimulationViewBridge } = load('src/simulation/simulation-view-bridge.ts')
    const bridge = new SimulationViewBridge(simulation, diagrams, settings)
    t.after(() => bridge.dispose())
    return { bridge, simulation, diagrams, changed, executed, sent, receive }
}

test('switching files hides the old run and returning restores its trace and queued inputs', (t) => {
    const { bridge, diagrams, changed, sent } = setup(t)
    const running = bridge.viewState()
    diagrams.currentUri = URI.parse(second)
    changed.fire()
    const other = sent.at(-1)
    assert.equal(other.modelUri, second)
    assert.equal(other.phase, 'idle')
    assert.equal(other.playing, false)
    assert.equal(other.tick, 0)
    assert.deepEqual(other.variables, [])
    diagrams.currentUri = URI.parse(first)
    changed.fire()
    assert.deepEqual(sent.at(-1), running)
    assert.equal(running.variables[0].next, 4)
    assert.deepEqual(running.variables[0].history, [1, 2, 3])
})

test('errors stay with their source file and URI matching handles encoded filenames', (t) => {
    const { bridge, simulation, diagrams } = setup(t)
    simulation.phase = 'idle'
    simulation.lastError = 'Compilation failed'
    simulation.modelUri = 'file:///models/my model.sctx'
    diagrams.currentUri = URI.parse(simulation.modelUri)
    assert.equal(bridge.viewState().error, simulation.lastError)
    assert.equal(bridge.viewState().model, 'my model.sctx')
    diagrams.currentUri = URI.parse(second)
    assert.equal(bridge.viewState().error, undefined)
    assert.equal(bridge.viewState().modelUri, second)
})

test('preview commands cannot control a run belonging to a different file', (t) => {
    const { diagrams, receive, executed } = setup(t)
    diagrams.currentUri = URI.parse(second)
    for (const kind of ['step', 'play', 'pause', 'stop', 'restart', 'saveTrace', 'loadTrace', 'setInput']) {
        receive({ kind, modelUri: first, id: 'input', value: 9 })
        receive({ kind, modelUri: second, id: 'input', value: 9 })
    }
    receive({ kind: 'start', modelUri: first })
    assert.deepEqual(executed, [])
    receive({ kind: 'start', modelUri: second })
    assert.equal(executed[0][0], 'keith-vscode.simulate')
    assert.equal(executed[0][1].toString(), second)
    diagrams.currentUri = URI.parse(first)
    receive({ kind: 'step', modelUri: first })
    assert.equal(executed[1][0], 'keith-vscode.simulation-step')
})

test('starting or stopping another file disables starting a new simulation', (t) => {
    const { bridge, diagrams, simulation, receive, executed } = setup(t)
    diagrams.currentUri = URI.parse(second)
    for (const phase of ['starting', 'stopping']) {
        simulation.phase = phase
        assert.equal(bridge.viewState().canStart, false)
        receive({ kind: 'start', modelUri: second })
    }
    assert.deepEqual(executed, [])
    simulation.phase = 'idle'
    assert.equal(bridge.viewState().canStart, true)
})

test('editor sync leaves the current diagram intact when focus returns to the same file', async () => {
    let changeEditor
    const opened = []
    const load = createLoader({
        vscode: { window: { onDidChangeActiveTextEditor: (handler) => { changeEditor = handler } } },
        '@kieler/klighd-core': {},
    })
    const { registerTextEditorSync } = load('src/diagram/commandContributions.ts')
    const manager = {
        currentUri: URI.parse('file:///models/my%20model.sctx'),
        findActiveWebview: () => undefined,
        getSyncWithEdior: () => true,
        storageService: { getItem: () => true },
        openDiagram: (uri) => opened.push(uri.toString()),
    }
    registerTextEditorSync(manager, { subscriptions: [] })
    await changeEditor({ document: { uri: manager.currentUri } })
    await changeEditor(undefined)
    assert.deepEqual(opened, [])
    await changeEditor({ document: { uri: URI.parse(second) } })
    assert.deepEqual(opened, [second])
    manager.getSyncWithEdior = () => false
    await changeEditor({ document: { uri: URI.parse(first) } })
    assert.equal(opened.length, 1)
})

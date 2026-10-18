const assert = require('node:assert/strict')
const { test } = require('node:test')
const createLoader = require('./load-typescript.cjs')

const { keepsViewport } = createLoader()('src-webview/diagram/viewport-policy.ts')

test('model updates keep the viewport while a simulation runs', () => {
    assert.equal(keepsViewport('updateModel', true), true)
    assert.equal(keepsViewport('setModel', true), true)
})

test('outside a simulation the diagram is refitted as before', () => {
    assert.equal(keepsViewport('updateModel', false), false)
    assert.equal(keepsViewport('setModel', false), false)
})

test('other server actions are untouched either way', () => {
    assert.equal(keepsViewport('elementSelected', true), false)
    assert.equal(keepsViewport('requestBounds', true), false)
    assert.equal(keepsViewport(undefined, true), false)
})

test('while a model of a running simulation is drawn, only the newest of the ones that arrive is drawn next', async () => {
    class Base {
        messageReceived(message) {
            this.plain.push(message.action.kind)
        }
    }
    const load = createLoader({
        '@kieler/klighd-core': { ServiceTypes: { Connection: Symbol('Connection') } },
        '@kieler/klighd-core/lib/diagram-server': { KlighdDiagramServer: Base },
        inversify: { inject: () => () => undefined, injectable: () => (target) => target },
    })
    const { KeithDiagramServer } = load('src-webview/diagram/diagram-server.ts')
    let running = true
    let acknowledged = 0
    const server = new KeithDiagramServer(undefined, () => running, () => acknowledged++)
    server.plain = []
    server.clientId = 'keith-diagram_sprotty'
    const drawn = []
    const stored = []
    const finish = []
    server.actionDispatcher = {
        dispatch: (action) => {
            // Marked as coming from the server, so sprotty does not send it back.
            assert.equal(action.__receivedFromServer, true)
            drawn.push(action.newRoot.id)
            return new Promise((resolve) => finish.push(resolve))
        },
    }
    server.storeNewModel = (action) => stored.push(action.newRoot.id)
    const update = (id) => ({ clientId: 'keith-diagram_sprotty', action: { kind: 'updateModel', newRoot: { id } } })
    const settle = () => new Promise((resolve) => setImmediate(resolve))

    server.messageReceived(update('tick1'))
    for (const id of ['tick2', 'tick3', 'tick4']) server.messageReceived(update(id))
    assert.deepEqual(drawn, ['tick1'])
    finish.shift()()
    await settle()
    assert.deepEqual(drawn, ['tick1', 'tick4'])
    assert.deepEqual(stored, ['tick1'])
    // Only the newest is acknowledged: Run waits for that before the next tick.
    assert.equal(acknowledged, 0)
    finish.shift()()
    await settle()
    assert.deepEqual(stored, ['tick1', 'tick4'])
    assert.equal(acknowledged, 1)
    // Another client's model is not drawn; outside a simulation every model goes the usual way.
    server.messageReceived({ clientId: 'other', action: { kind: 'updateModel', newRoot: { id: 'x' } } })
    assert.deepEqual(drawn, ['tick1', 'tick4'])
    running = false
    server.messageReceived(update('after'))
    assert.deepEqual(server.plain, ['updateModel'])
})

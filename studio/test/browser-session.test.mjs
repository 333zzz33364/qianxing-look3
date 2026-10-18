import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlaySession, keyEventName, PLAY_MOVE_THROTTLE_MS, PLAY_POLL_INTERVAL_MS } from '../play/browser-session.js'

test('stopping during startup rejects late scenes and leaves no active polling', async () => {
  let resolveStart
  const rendered = [], observed = [], calls = []
  const play = createPlaySession({
    renderer: { applyScene: scene => rendered.push(scene), destroy() {} },
    api(action) {
      calls.push(action)
      if (action === 'start') return new Promise(resolve => { resolveStart = resolve })
      return Promise.resolve({ running: false })
    },
    onSnapshot: value => observed.push(value),
  })
  const pending = play.start()
  await play.stop()
  resolveStart({ scene: { format: 'tree-v1', revision: 1 }, canvasWidth: 800, canvasHeight: 450 })
  await pending
  assert.equal(play.running, false)
  assert.equal(play.snapshot, null)
  assert.deepEqual(rendered, [])
  assert.deepEqual(observed, [])
  await play.poll()
  assert.deepEqual(calls, ['start', 'stop'])
  play.destroy()
})

test('a pending poll cannot update a destroyed editor surface', async () => {
  let resolvePoll
  const observed = []
  let destroyed = 0
  const play = createPlaySession({
    renderer: { applyScene() {}, destroy() { destroyed++ } },
    api(action) {
      if (action === 'get') return new Promise(resolve => { resolvePoll = resolve })
      return Promise.resolve({ running: true, scene: { format: 'tree-v1', revision: 1 }, canvasWidth: 800, canvasHeight: 450 })
    }, onSnapshot: value => observed.push(value),
  })
  await play.start()
  play.stopPolling()
  const pending = play.poll()
  play.destroy()
  play.destroy()
  resolvePoll({ running: true, scene: { format: 'tree-v1', revision: 2 } })
  await pending
  assert.equal(observed.length, 1)
  assert.equal(play.running, false)
  assert.equal(play.snapshot, null)
  assert.equal(destroyed, 1)
})

test('canvas input is local, releases held keys on blur, and removes all listeners', async () => {
  class Surface extends EventTarget {
    focus() { this.focused = true }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 100, width: 200, height: 100 } }
  }
  const surface = new Surface(), calls = []
  const play = createPlaySession({ renderer: { applyScene() {}, destroy() {} },
    async api(action, args) { calls.push({ action, args }); return { running: true, canvasWidth: 800, canvasHeight: 400 } } })
  await play.start()
  play.stopPolling()
  play.bindInput(surface)
  const key = new Event('keydown', { cancelable: true }); key.code = 'KeyW'
  surface.dispatchEvent(key)
  surface.dispatchEvent(key)
  surface.dispatchEvent(new Event('blur'))
  const pointer = new Event('pointerdown'); pointer.clientX = 50; pointer.clientY = 75
  surface.dispatchEvent(pointer)
  await Promise.resolve()
  assert.deepEqual(calls.filter(row => row.action === 'key').map(row => row.args.key), ['KeyboardMoveForwardKeyDown', 'KeyboardMoveForwardKeyUp'])
  assert.equal(surface.focused, true)
  assert.deepEqual(calls.find(row => row.action === 'pointer').args, { light: true, type: 'down', x: 200, y: 100 })
  play.destroy()
  const before = calls.length
  surface.dispatchEvent(key); surface.dispatchEvent(pointer)
  assert.equal(calls.length, before)
})

test('restarting clears queued pointer movement and held keys without stale key-up input', async () => {
  class Surface extends EventTarget {
    focus() {}
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 100, width: 200, height: 100 } }
  }
  const surface = new Surface(), calls = []
  const play = createPlaySession({ renderer: { applyScene() {}, destroy() {} },
    async api(action, args = {}) {
      calls.push({ action, key: args.key, type: args.type, x: args.x, y: args.y })
      if (action === 'start' || action === 'get') return { running: true, canvasWidth: 200, canvasHeight: 100 }
      return { running: action !== 'stop' }
    } })
  await play.start()
  play.stopPolling()
  play.bindInput(surface)

  const keydown = () => {
    const event = new Event('keydown', { cancelable: true })
    event.code = 'KeyW'
    surface.dispatchEvent(event)
  }
  keydown()
  const oldMove = new Event('pointermove')
  oldMove.clientX = 175
  oldMove.clientY = 25
  surface.dispatchEvent(oldMove)

  await play.stop()
  await play.start()
  play.stopPolling()
  keydown()
  await new Promise(resolve => setTimeout(resolve, PLAY_MOVE_THROTTLE_MS + 10))

  assert.deepEqual(calls.filter(row => row.action === 'key').map(row => row.key), [
    'KeyboardMoveForwardKeyDown',
    'KeyboardMoveForwardKeyDown',
  ])
  assert.deepEqual(calls.filter(row => row.action === 'pointer'), [])
  play.destroy()
})

test('pointer leave cancels a queued in-bounds move before sending the outside move', async () => {
  class Surface extends EventTarget {
    focus() {}
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 100, width: 200, height: 100 } }
  }
  const surface = new Surface(), calls = []
  const play = createPlaySession({ renderer: { applyScene() {}, destroy() {} },
    async api(action, args = {}) {
      if (action === 'pointer') calls.push({ type: args.type, x: args.x, y: args.y })
      if (action === 'start' || action === 'get') return { running: true, canvasWidth: 200, canvasHeight: 100 }
      return { running: action !== 'stop' }
    } })
  await play.start()
  play.stopPolling()
  play.bindInput(surface)
  const move = new Event('pointermove')
  move.clientX = 175
  move.clientY = 25
  surface.dispatchEvent(move)
  surface.dispatchEvent(new Event('pointerleave'))
  await new Promise(resolve => setTimeout(resolve, PLAY_MOVE_THROTTLE_MS + 10))

  assert.deepEqual(calls, [{ type: 'move', x: -1, y: -1 }])
  play.destroy()
})

test('reloading a browser attaches to the existing paused game without a start or player change', async t => {
  const calls = [], rendered = []
  const snapshot = { running: true, paused: true, frame: 1254, time: 41.8,
    canvasWidth: 1280, canvasHeight: 720, viewPlayerIndex: 2,
    scene: { format: 'tree-v1', revision: 7, reset: true, nodes: [] } }
  const play = createPlaySession({
    renderer: { async applyScene(scene) { rendered.push(scene) } },
    async api(action, args) { calls.push({ action, args }); return snapshot },
  })
  t.after(() => play.destroy())
  await play.attach()
  play.stopPolling()
  assert.deepEqual(calls, [{ action: 'get', args: { view: true, compact: true, sceneRev: 0 } }])
  assert.equal(play.running, true)
  assert.equal(play.snapshot.paused, true)
  assert.equal(play.snapshot.frame, 1254)
  assert.equal(play.snapshot.viewPlayerIndex, 2)
  assert.equal(play.sceneRev, 7)
  assert.equal(rendered.length, 1)
})

test('shared play loop polls compact scene views and sends light input', async () => {
  const calls = []
  const scenes = []
  const statuses = []
  let sceneRevSeen
  const renderer = {
    applied: [],
    async applyScene(scene, width, height) { this.applied.push({ scene, width, height }) },
    async render() {},
    destroy() { this.destroyed = true },
  }
  const play = createPlaySession({
    renderer,
    async api(action, args = {}) {
      calls.push({ action, args })
      if (action === 'start' || action === 'get') {
        sceneRevSeen = args.sceneRev
        return {
          running: true,
          paused: false,
          frame: calls.length,
          time: 0.1,
          canvasWidth: 1600,
          canvasHeight: 900,
          scene: { format: 'tree-v1', revision: 2, reset: action === 'start', nodes: [] },
        }
      }
      if (action === 'pointer' || action === 'key' || action === 'step') {
        return { running: true, paused: false, frame: 3, time: 0.2 }
      }
      if (action === 'stop') return { running: false }
      return { running: true }
    },
    onSnapshot: (next) => scenes.push(next),
    onStatus: (next) => statuses.push(next),
  })

  await play.start({ canvasId: 'pc-16-9' })
  assert.equal(calls[0].action, 'start')
  assert.equal(calls[0].args.view, true)
  assert.equal(calls[0].args.compact, true)
  assert.equal(calls[0].args.canvasId, 'pc-16-9')
  assert.equal(renderer.applied.length, 1)
  assert.equal(scenes.length, 1)

  await play.act('pointer', { type: 'down', x: 10, y: 20 })
  const pointer = calls.find((call) => call.action === 'pointer')
  assert.equal(pointer.args.light, true)
  assert.equal(pointer.args.type, 'down')
  assert.equal(statuses.length, 1)

  await play.poll()
  const get = calls.find((call) => call.action === 'get')
  assert.equal(get.args.view, true)
  assert.equal(get.args.compact, true)
  assert.equal(get.args.sceneRev, 2)
  assert.equal(sceneRevSeen, 2)

  play.destroy()
  assert.equal(renderer.destroyed, true)
  assert.equal(PLAY_POLL_INTERVAL_MS, 33)
  assert.equal(keyEventName({ code: 'Digit1' }, 'Down'), 'KeyboardCraftspersonKey1Down')
  assert.equal(keyEventName({ code: 'KeyA' }, 'Down'), 'KeyboardMoveLeftKeyDown')
  assert.equal(keyEventName({ code: 'KeyA' }, 'Up'), 'KeyboardMoveLeftKeyUp')
  assert.equal(keyEventName({ code: 'KeyZ' }, 'Down'), '')
})

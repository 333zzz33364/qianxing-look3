import test from 'node:test'
import assert from 'node:assert/strict'
import { createResourcesPanel } from '../../editor-ui/look2-resources.js'

const defaults = { defaultsVersion: 1, count: 400, resolution: 512, workers: 16, shapes: ['ellipse', 'rectangle'], transparent: true }

function clone(value) { return structuredClone(value) }

function mountPanel(initialResources, initialSiteNodes = {}) {
  const slots = []
  const effects = []
  const pendingChanges = []
  const messages = []
  const errors = []
  let cursor = 0
  let effectCursor = 0
  let writes = 0
  let state = { primitiveResources: clone(initialResources), siteNodes: clone(initialSiteNodes) }
  let tree
  const props = { selectedId: undefined }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, values, ...children) => ({
      type, props: values || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false),
    }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (!Object.is(value, slots[index])) { slots[index] = value; writes++ }
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(callback, dependencies) {
      const index = effectCursor++
      const previous = effects[index]
      const changed = !previous || !dependencies || dependencies.length !== previous.dependencies?.length ||
        dependencies.some((value, item) => !Object.is(value, previous.dependencies[item]))
      if (changed) effects[index] = { callback, dependencies, cleanup: previous?.cleanup || null, changed: true }
      else effects[index] = { ...previous, changed: false }
    },
  }
  const { ResourcesPanel } = createResourcesPanel(React)

  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  function render() {
    for (let pass = 0; pass < 6; pass++) {
      const before = writes
      cursor = 0
      effectCursor = 0
      tree = ResourcesPanel({
        state,
        getState: () => state,
        selectedId: props.selectedId,
        workerURL: '/fit-worker.js',
        onChange: (mutate, label) => new Promise((resolve, reject) => pendingChanges.push({ mutate, label, resolve, reject })),
        onClose() {}, onError(message) { errors.push(message) }, onMessage(message) { messages.push(message) },
      })
      for (let index = 0; index < 2; index++) {
        const effect = effects[index]
        if (!effect?.changed) continue
        effect.cleanup?.()
        const cleanup = effect.callback()
        effect.cleanup = typeof cleanup === 'function' ? cleanup : null
        effect.changed = false
      }
      if (writes === before) break
    }
    return tree
  }
  const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve() }
  async function resolveNext() {
    await flush()
    const request = pendingChanges.shift()
    assert.ok(request, 'expected a queued resource transaction')
    const next = clone(state)
    request.mutate(next)
    state = next
    render()
    request.resolve(state)
    await flush()
    render()
    return request
  }
  async function rejectNext(error = new Error('temporary transaction failure')) {
    await flush()
    const request = pendingChanges.shift()
    assert.ok(request, 'expected a queued resource transaction')
    request.reject(error)
    await flush()
    render()
    return request
  }
  function input(predicate) { const node = find(predicate)[0]; assert.ok(node, 'expected input control'); return node }
  function resolution() {
    return input(node => node.type === 'select' && find(child => child.props?.value === 256, node).length > 0)
  }
  function number(min, max) {
    return input(node => node.type === 'input' && node.props.type === 'number' && node.props.min === min && node.props.max === max)
  }
  function shape(name) {
    const labels = { ellipse: '椭圆', rectangle: '矩形', triangle: '三角形' }
    const label = input(node => node.type === 'label' && node.children.includes(labels[name]))
    return find(node => node.type === 'input' && node.props.type === 'checkbox', label)[0]
  }
  function transparent() {
    const label = input(node => node.type === 'label' && node.children.includes('透明背景'))
    return find(node => node.type === 'input' && node.props.type === 'checkbox', label)[0]
  }
  function setValue(node, value) { node.props.onChange({ target: { value: String(value) } }); render() }
  function setChecked(node, checked) { node.props.onChange({ target: { checked } }); render() }

  render()
  return {
    find, render, flush, resolveNext, rejectNext,
    state: () => state,
    pendingChanges,
    messages,
    errors,
    visibleResourceIds: () => {
      const ids = new Set(initialResources.map(row => row.id))
      return find(node => node.type === 'button' && ids.has(node.props?.key)).map(node => node.props.key)
    },
    setSelectedId(id) { props.selectedId = id; render() },
    selectResource(id) { input(node => node.type === 'button' && node.props.key === id).props.onClick(); render() },
    searchResources(value) { setValue(input(node => node.props?.['aria-label'] === '搜索资源'), value) },
    clickButton(label) { input(node => node.type === 'button' && node.children.includes(label)).props.onClick(); render() },
    options: () => ({
      count: Number(number(1, 1000).props.value),
      resolution: Number(resolution().props.value),
      workers: Number(number(1, 16).props.value),
      shapes: ['ellipse', 'rectangle', 'triangle'].filter(name => shape(name).props.checked),
      transparent: transparent().props.checked,
    }),
    setCount(value) { setValue(number(1, 1000), value) },
    setResolution(value) { setValue(resolution(), value) },
    setWorkers(value) { setValue(number(1, 16), value) },
    setShape(name, checked) { setChecked(shape(name), checked) },
    setTransparent(checked) { setChecked(transparent(), checked) },
  }
}

function resource(id, name, fitOptions = defaults, imageUrl = 'data:image/png;base64,AA==') {
  return { id, name, imageUrl, fitData: null, fitOptions: clone(fitOptions), previewMode: 'image' }
}

function createFitWorker({ onBlocked } = {}) {
  const records = []
  class FakeWorker {
    constructor(url) {
      this.url = url
      this.record = { url, source: '', resolution: 0, shapes: [], transparent: true, searches: 0, commits: 0, terminated: false }
      records.push(this.record)
    }
    postMessage(message) {
      if (message.type === 'decode') {
        this.record.source = message.source
        this.record.resolution = message.resolution
        if (message.source.includes('FAIL')) {
          queueMicrotask(() => this.onmessage?.({ data: { type: 'error', message: '合成 Worker 失败' } }))
        } else if (message.source.includes('BLOCK')) {
          onBlocked?.(message.source)
        } else {
          queueMicrotask(() => this.onmessage?.({ data: {
            type: 'decoded', width: 2, height: 2, gridWidth: 2, gridHeight: 2,
            pixels: new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]).buffer,
          } }))
        }
      } else if (message.type === 'init') {
        this.record.shapes = message.shapes
        this.record.transparent = message.transparent
        queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }))
      } else if (message.type === 'search') {
        this.record.searches += 1
        queueMicrotask(() => this.onmessage?.({ data: { type: 'candidate', candidate: {
          improvement: 1,
          element: { type: 'rectangle', imageId: 100001, x: 0, y: 0, width: 2, height: 2, rotation: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
        } } }))
      } else if (message.type === 'commit') {
        this.record.commits += 1
        queueMicrotask(() => this.onmessage?.({ data: { type: 'committed', remaining: 1, error: 0 } }))
      }
    }
    terminate() { this.record.terminated = true }
  }
  return { Worker: FakeWorker, records }
}

const batchSummary = message => /^(?:批量拟合已取消|批量拟合完成|批量拟合未开始)/.test(message)
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

async function waitForBatchSummary(panel) {
  for (let turn = 0; turn < 250; turn += 1) {
    await panel.flush()
    if (panel.pendingChanges.length) {
      await panel.resolveNext()
      continue
    }
    panel.render()
    const summary = panel.messages.find(batchSummary)
    if (summary) return summary
    await tick()
  }
  assert.fail('batch fit did not publish a summary')
}

async function driveUntil(panel, predicate, description) {
  for (let turn = 0; turn < 250; turn += 1) {
    await panel.flush()
    if (predicate()) return
    if (panel.pendingChanges.length) {
      await panel.resolveNext()
      continue
    }
    panel.render()
    if (predicate()) return
    await tick()
  }
  assert.fail(`timed out waiting for ${description}`)
}

async function waitForPendingChange(panel, description) {
  for (let turn = 0; turn < 250; turn += 1) {
    await panel.flush()
    if (panel.pendingChanges.length) return
    await tick()
  }
  assert.fail(`timed out waiting for ${description}`)
}

test('RS02 clearing one binding preserves a different resource field, and removal is scoped', async () => {
  const panel = mountPanel([resource('a', '原图'), resource('b', '图元')], {
    both: { properties: { imageResourceId: 'a', primitiveResourceId: 'b' } },
    onlyB: { properties: { primitiveResourceId: 'b' } },
    onlyA: { properties: { imageResourceId: 'a' } },
  })
  panel.selectResource('a')
  panel.clickButton('清除全部绑定')
  const clear = await panel.resolveNext()
  assert.equal(clear.label, '清除图片资源绑定')
  assert.deepEqual(panel.state().siteNodes, {
    both: { properties: { primitiveResourceId: 'b' } },
    onlyB: { properties: { primitiveResourceId: 'b' } },
    onlyA: { properties: {} },
  })
  assert.deepEqual(panel.state().primitiveResources.map(item => item.id), ['a', 'b'])

  panel.selectResource('b')
  panel.clickButton('移除资源及绑定')
  const removed = await panel.resolveNext()
  assert.equal(removed.label, '移除图片资源及绑定')
  assert.deepEqual(panel.state().primitiveResources.map(item => item.id), ['a'])
  assert.deepEqual(panel.state().siteNodes, {
    both: { properties: {} },
    onlyB: { properties: {} },
    onlyA: { properties: {} },
  })
})

test('late resource snapshots keep newer fit options and queued edits merge every field', async () => {
  const panel = mountPanel([resource('a', '甲')])
  panel.setResolution(256)
  await panel.flush()
  assert.equal(panel.pendingChanges.length, 1)

  panel.setCount(420)
  panel.setWorkers(4)
  panel.setShape('triangle', true)
  panel.setTransparent(false)
  assert.deepEqual(panel.options(), { count: 420, resolution: 256, workers: 4, shapes: ['ellipse', 'rectangle', 'triangle'], transparent: false })

  await panel.resolveNext()
  assert.deepEqual(panel.options(), { count: 420, resolution: 256, workers: 4, shapes: ['ellipse', 'rectangle', 'triangle'], transparent: false }, 'an older response must not replace the current draft')

  // A new edit while older queued saves are still pending must build on the latest draft.
  panel.setCount(430)
  for (let count = 0; count < 12; count++) {
    await panel.flush()
    if (!panel.pendingChanges.length) break
    await panel.resolveNext()
  }
  assert.deepEqual(panel.state().primitiveResources[0].fitOptions, {
    ...defaults, count: 430, resolution: 256, workers: 4,
    shapes: ['ellipse', 'rectangle', 'triangle'], transparent: false,
  })
})

test('resource selection loads its own options and failed saves preserve the draft for retry', async () => {
  const panel = mountPanel([
    resource('a', '甲'),
    resource('b', '乙', { ...defaults, count: 120, resolution: 128, workers: 2, shapes: ['triangle'], transparent: false }),
  ])
  panel.selectResource('b')
  assert.deepEqual(panel.options(), { count: 120, resolution: 128, workers: 2, shapes: ['triangle'], transparent: false })
  panel.setResolution(256)
  await panel.rejectNext()
  assert.equal(panel.options().resolution, 256)

  panel.setCount(121)
  await panel.resolveNext()
  const saved = panel.state().primitiveResources.find(row => row.id === 'b').fitOptions
  assert.equal(saved.resolution, 256)
  assert.equal(saved.count, 121)
  assert.equal(saved.workers, 2)
  assert.deepEqual(saved.shapes, ['triangle'])
  assert.equal(saved.transparent, false)
})

test('changing the editor-selected resource synchronizes the panel selection and options', () => {
  const panel = mountPanel([
    resource('a', '甲'),
    resource('b', '乙', { ...defaults, count: 80, resolution: 64, workers: 1, shapes: ['rectangle'], transparent: false }),
  ])
  panel.setSelectedId('b')
  assert.deepEqual(panel.options(), { count: 80, resolution: 64, workers: 1, shapes: ['rectangle'], transparent: false })
})

test('batch fit ignores resource search, uses each image options, and counts failures while continuing', async () => {
  const fitWorker = createFitWorker()
  const previousWorker = globalThis.Worker
  globalThis.Worker = fitWorker.Worker
  try {
    const panel = mountPanel([
      resource('shown', '显示甲', { ...defaults, count: 2, resolution: 64, workers: 1, shapes: ['triangle'], transparent: false }, 'data:image/png;base64,SHOWN'),
      resource('hidden-fail', '隐藏失败乙', { ...defaults, count: 4, resolution: 128, workers: 1, shapes: ['ellipse'], transparent: true }, 'data:image/png;base64,FAIL'),
      resource('hidden', '隐藏丙', { ...defaults, count: 3, resolution: 256, workers: 1, shapes: ['rectangle'], transparent: true }, 'data:image/png;base64,HIDDEN'),
    ])
    panel.searchResources('显示甲')
    assert.deepEqual(panel.visibleResourceIds(), ['shown'])
    panel.clickButton('批量拟合未完成资源')
    const summary = await waitForBatchSummary(panel)

    assert.equal(summary, '批量拟合完成；成功 2 张，失败 1 张，取消 0 张，未处理 0 张')
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'shown').fitData.elements.length, 3, 'opaque fit contains two fitted elements plus its white base')
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'hidden-fail').fitData, null)
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'hidden').fitData.elements.length, 3)
    assert.deepEqual(fitWorker.records.map(({ source, resolution, shapes, transparent, commits }) => ({ source, resolution, shapes, transparent, commits })), [
      { source: 'data:image/png;base64,SHOWN', resolution: 64, shapes: ['triangle'], transparent: false, commits: 2 },
      { source: 'data:image/png;base64,FAIL', resolution: 128, shapes: [], transparent: true, commits: 0 },
      { source: 'data:image/png;base64,HIDDEN', resolution: 256, shapes: ['rectangle'], transparent: true, commits: 3 },
    ])
    assert.equal(panel.errors.length, 1)
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

test('batch cancellation counts the interrupted image and leaves later images unprocessed', async () => {
  let blockedSource = ''
  const fitWorker = createFitWorker({ onBlocked: source => { blockedSource = source } })
  const previousWorker = globalThis.Worker
  globalThis.Worker = fitWorker.Worker
  try {
    const panel = mountPanel([
      resource('done', '已完成', { ...defaults, count: 1 }, 'data:image/png;base64,DONE'),
      resource('blocked', '正在拟合', { ...defaults, count: 2 }, 'data:image/png;base64,BLOCK'),
      resource('later', '尚未启动', defaults, 'data:image/png;base64,LATER'),
    ])
    panel.clickButton('批量拟合未完成资源')
    await driveUntil(panel, () => Boolean(blockedSource), 'second image worker to start')
    panel.render()
    panel.clickButton('取消')
    const summary = await waitForBatchSummary(panel)

    assert.equal(summary, '批量拟合已取消；成功 1 张，失败 0 张，取消 1 张，未处理 1 张')
    const counts = [...summary.matchAll(/(?:成功|失败|取消|未处理) (\d+) 张/g)].map(match => Number(match[1]))
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 3)
    assert.ok(panel.state().primitiveResources.find(row => row.id === 'done').fitData)
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'blocked').fitData, null)
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'later').fitData, null)
    assert.equal(fitWorker.records.some(row => row.source === 'data:image/png;base64,LATER'), false)
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

test('cancelling between fitted images counts the committed image as success and the rest as unprocessed', async () => {
  const fitWorker = createFitWorker()
  const previousWorker = globalThis.Worker
  globalThis.Worker = fitWorker.Worker
  try {
    const panel = mountPanel([
      resource('first', '第一张', { ...defaults, count: 1, workers: 1 }, 'data:image/png;base64,FIRST'),
      resource('second', '第二张', { ...defaults, workers: 1 }, 'data:image/png;base64,SECOND'),
      resource('third', '第三张', { ...defaults, workers: 1 }, 'data:image/png;base64,THIRD'),
    ])
    panel.clickButton('批量拟合未完成资源')
    await waitForPendingChange(panel, 'first fit result transaction')
    panel.render()
    panel.clickButton('取消')
    await panel.resolveNext()
    const summary = await waitForBatchSummary(panel)

    assert.equal(summary, '批量拟合已取消；成功 1 张，失败 0 张，取消 0 张，未处理 2 张')
    const counts = [...summary.matchAll(/(?:成功|失败|取消|未处理) (\d+) 张/g)].map(match => Number(match[1]))
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 3)
    assert.ok(panel.state().primitiveResources.find(row => row.id === 'first').fitData)
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'second').fitData, null)
    assert.equal(panel.state().primitiveResources.find(row => row.id === 'third').fitData, null)
    assert.deepEqual(fitWorker.records.map(row => row.source), ['data:image/png;base64,FIRST'])
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

test('failed fit option saves stop a batch clearly and keep the error and draft visible', async () => {
  const fitWorker = createFitWorker()
  const previousWorker = globalThis.Worker
  globalThis.Worker = fitWorker.Worker
  try {
    const panel = mountPanel([resource('a', '甲')])
    panel.setResolution(256)
    await panel.rejectNext()
    panel.clickButton('批量拟合未完成资源')
    const summary = await waitForBatchSummary(panel)

    assert.equal(summary, '批量拟合未开始：拟合选项保存失败，待处理资源均未启动')
    assert.equal(panel.options().resolution, 256)
    assert.match(panel.errors[0], /temporary transaction failure/)
    assert.equal(fitWorker.records.length, 0)
  } finally {
    if (previousWorker === undefined) delete globalThis.Worker
    else globalThis.Worker = previousWorker
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { uiVfxCatalog, UI_VFX_BASE } from '../play/ui-vfx-catalog.js'
import { attachUIVfxRenderer } from '../../editor-ui/ui-vfx-preview.js'
import { createUIVfxLibrary } from '../../editor-ui/ui-vfx-library.js'
import { createUIVfxField } from '../../editor-ui/ui-vfx-field.js'

const catalogFixture = {
  data: [
    { id: 1, path: 'icon/1.png', icon: 'icon/1s.png', width: 100, height: 50, scope: 'ui', category: 10, tagList: [101], isLoop: true, nameI18nKey: 'vfx.1' },
    { id: 2, path: 'icon/2.png', width: 50, height: 100, scope: 'ui', category: 20, tagList: [102], isLoop: false, nameI18nKey: 'vfx.2' },
    { id: 3, path: 'icon/3.png', width: 200, height: 200, scope: 'screen', category: 30, tagList: [101], isLoop: false, nameI18nKey: 'vfx.3' },
  ],
  tags: [{ id: 101, nameI18nKey: 'tag.101' }, { id: 102, nameI18nKey: 'tag.102' }],
  category: [
    { id: 10, nameI18nKey: 'cat.10', scope: 'ui' },
    { id: 20, nameI18nKey: 'cat.20', scope: 'ui' },
    { id: 30, nameI18nKey: 'cat.30', scope: 'screen' },
  ],
}
const labels = {
  'vfx.1': '火花', 'vfx.2': '雨滴', 'vfx.3': '闪电',
  'tag.101': '火焰', 'tag.102': '水', 'cat.10': '战斗', 'cat.20': '环境', 'cat.30': '全屏特效',
}

function stubWindow() {
  const previous = globalThis.window
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  return () => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous }
}

function stubFetch() {
  const previous = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (url === `${UI_VFX_BASE}/data.json`) return { ok: true, status: 200, json: async () => catalogFixture }
    if (url === `${UI_VFX_BASE}/i18n/zh-cn.json`) return { ok: true, status: 200, json: async () => labels }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return () => { globalThis.fetch = previous }
}

function createHarness() {
  const slots = []
  let cursor = 0
  const effects = []
  let memoCalls = 0
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined && value !== false) }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect(effect) { effects.push(effect) },
    useCallback: callback => callback,
    useMemo(factory) { memoCalls++; return factory() },
    memo: component => component,
  }
  const reset = () => { cursor = 0 }
  const runEffects = () => {
    const cleanups = []
    for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
    return cleanups
  }
  return { React, slots, reset, runEffects, memoCalls: () => memoCalls }
}

function collect(tree, predicate, found = []) {
  if (!tree || typeof tree !== 'object') return found
  if (predicate(tree)) found.push(tree)
  for (const child of tree.children || []) collect(child, predicate, found)
  return found
}
function textOf(node) {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children || []).map(textOf).join('')
}
const buttonByText = (tree, text) => collect(tree, node => node.type === 'button' && textOf(node).includes(text))[0]
const byClass = (tree, className) => collect(tree, node => String(node.props.className || '').split(/\s+/).includes(className))

test('UIVfxLibrary filters by scope, category, tag and keyword and reports the selection', async () => {
  const restore = stubFetch()
  const restoreWindow = stubWindow()
  try {
    const { React, reset, runEffects } = createHarness()
    const UIVfxLibrary = createUIVfxLibrary(React)
    const selected = []
    const closed = []
    const render = () => { reset(); return UIVfxLibrary({ scope: 'ui', selectedId: 1, onSelect: asset => selected.push(asset), onClose: () => closed.push(true) }) }

    const loading = render()
    assert.equal(textOf(loading).includes('正在加载动效素材'), true)
    const cleanups = runEffects()
    await new Promise(resolve => setImmediate(resolve))

    let tree = render()
    const cards = () => collect(tree, node => node.type === 'button' && node.props.title && /（#\d+）/.test(String(node.props.title)))
    assert.equal(cards().length, 2, 'only ui scope assets are listed')
    assert.equal(textOf(tree).includes('2 / 2'), true)

    // Category chip narrows the list; pressing it again clears the filter.
    const combat = buttonByText(tree, '战斗')
    combat.props.onClick()
    tree = render()
    assert.equal(cards().length, 1)
    assert.equal(cards()[0].props.title.includes('火花'), true)
    buttonByText(tree, '战斗').props.onClick()
    tree = render()
    assert.equal(cards().length, 2)

    // Tag selector and keyword search compose with each other.
    const select = collect(tree, node => node.type === 'select')[0]
    select.props.onChange({ target: { value: '102' } })
    tree = render()
    assert.equal(cards().length, 1)
    assert.equal(cards()[0].props.title.includes('雨滴'), true)
    const search = collect(tree, node => node.type === 'input' && node.props['aria-label'] === '搜索界面动效')[0]
    search.props.onChange({ target: { value: '火花' } })
    tree = render()
    assert.equal(cards().length, 0, 'tag 102 and keyword 火花 do not intersect')
    select.props.onChange({ target: { value: '0' } })
    tree = render()
    assert.equal(cards().length, 1)
    assert.equal(textOf(tree).includes('没有符合条件的动效'), false)

    search.props.onChange({ target: { value: '不存在' } })
    tree = render()
    assert.equal(textOf(tree).includes('没有符合条件的动效'), true)

    // id search works without a translated name.
    search.props.onChange({ target: { value: '2' } })
    tree = render()
    assert.equal(cards().length, 1)
    assert.equal(cards()[0].props.title.includes('雨滴'), true)

    cards()[0].props.onClick()
    assert.equal(selected.length, 1)
    assert.equal(selected[0].id, 2)

    for (const cleanup of cleanups) cleanup()
    assert.equal(closed.length, 0)
  } finally { restore(); restoreWindow() }
})

test('UIVfxLibrary closes on Escape, backdrop click and the close button but not on inner clicks', async () => {
  const restore = stubFetch()
  try {
    const { React, reset, runEffects } = createHarness()
    const UIVfxLibrary = createUIVfxLibrary(React)
    const closed = []
    let keyHandler = null
    const previousWindow = globalThis.window
    globalThis.window = { addEventListener: (name, handler) => { if (name === 'keydown') keyHandler = handler }, removeEventListener: () => {} }
    const render = () => { reset(); return UIVfxLibrary({ scope: 'screen', onSelect() {}, onClose: () => closed.push(true) }) }
    render()
    const cleanups = runEffects()
    await new Promise(resolve => setImmediate(resolve))
    const tree = render()
    assert.equal(buttonByText(tree, '全屏动效') !== undefined || textOf(tree).includes('选择全屏动效'), true)

    const overlay = tree
    overlay.props.onClick({ target: 'inner', currentTarget: 'outer' })
    assert.equal(closed.length, 0)
    overlay.props.onClick({ target: 'same', currentTarget: 'same' })
    assert.equal(closed.length, 1)
    buttonByText(tree, '关闭').props.onClick()
    assert.equal(closed.length, 2)
    keyHandler({ key: 'Enter' })
    assert.equal(closed.length, 2)
    keyHandler({ key: 'Escape' })
    assert.equal(closed.length, 3)

    for (const cleanup of cleanups) cleanup()
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow
  } finally { restore() }
})

function stubAnimationFrame() {
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const scheduled = []
  globalThis.requestAnimationFrame = handler => { scheduled.push(handler); return scheduled.length }
  globalThis.cancelAnimationFrame = () => {}
  return {
    scheduled,
    restore() {
      if (previousRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousRaf
      if (previousCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCancel
    },
  }
}

test('UIVfxLibrary shows a failure state and retries the catalog load', async () => {
  const previous = globalThis.fetch
  const restoreWindow = stubWindow()
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  try {
    const { React, reset, runEffects } = createHarness()
    const UIVfxLibrary = createUIVfxLibrary(React)
    const render = () => { reset(); return UIVfxLibrary({ scope: 'ui', onSelect() {}, onClose() {} }) }
    render()
    runEffects()
    await new Promise(resolve => setImmediate(resolve))
    let tree = render()
    assert.equal(textOf(tree).includes('素材加载失败'), true)

    const attempts = []
    globalThis.fetch = async (url) => {
      attempts.push(url)
      if (url === `${UI_VFX_BASE}/data.json`) return { ok: true, status: 200, json: async () => catalogFixture }
      return { ok: true, status: 200, json: async () => labels }
    }
    buttonByText(tree, '重试').props.onClick()
    runEffects()
    await new Promise(resolve => setImmediate(resolve))
    tree = render()
    assert.equal(textOf(tree).includes('素材加载失败'), false)
    assert.ok(attempts.some(url => url === `${UI_VFX_BASE}/data.json`))
  } finally { globalThis.fetch = previous; restoreWindow() }
})

test('UIVfxField shows the selected asset, commits removal and toggles its preview', async () => {
  const restore = stubFetch()
  try {
    const { React, reset, runEffects } = createHarness()
    await uiVfxCatalog.load(true)
    const UIVfxField = createUIVfxField(React)
    const committed = []
    const render = value => { reset(); return UIVfxField({ field: { key: 'animationId', label: '界面动效', value }, scope: 'ui', commit: (key, next) => committed.push([key, next]) }) }

    let tree = render('')
    assert.equal(textOf(tree).includes('未选择动效'), true)
    assert.equal(textOf(tree).includes('作用域：界面'), true)
    assert.equal(collect(tree, node => node.props.title === '移除动效').length, 0)

    runEffects()
    await new Promise(resolve => setImmediate(resolve))
    tree = render('1')
    assert.equal(textOf(tree).includes('火花'), true)
    assert.equal(textOf(tree).includes('循环 · 100×50'), true)
    const video = collect(tree, node => node.type === 'video')[0]
    assert.match(video.props.src, /icon\/1\.png$/)
    assert.equal(video.props.loop, true)

    buttonByText(tree, '隐藏预览').props.onClick()
    tree = render('1')
    assert.equal(textOf(tree).includes('显示预览'), true)

    collect(tree, node => node.props['aria-label'] === '重播预览')[0].props.onClick()
    collect(tree, node => node.props['aria-label'] === '移除动效')[0].props.onClick()
    assert.deepEqual(committed, [['animationId', '']])

    // 未知编号在目录就绪后仍显示原始 ID。
    tree = render('9999')
    assert.equal(textOf(tree).includes('#9999'), true)
    assert.equal(textOf(tree).includes('未选择动效'), false)
  } finally { restore() }
})

test('UIVfxField opens the library and forwards the chosen asset', async () => {
  const restore = stubFetch()
  try {
    const { React, reset, runEffects } = createHarness()
    await uiVfxCatalog.load(true)
    const UIVfxField = createUIVfxField(React)
    const committed = []
    const render = () => { reset(); return UIVfxField({ field: { key: 'animationId', label: '界面动效', value: '' }, scope: 'ui', commit: (key, next) => committed.push([key, next]) }) }
    let tree = render()
    runEffects()
    await new Promise(resolve => setImmediate(resolve))
    tree = render()
    assert.equal(collect(tree, node => node.type?.name === 'UIVfxLibrary').length, 0)
    buttonByText(tree, '未选择动效').props.onClick()
    tree = render()
    const library = collect(tree, node => node.type?.name === 'UIVfxLibrary')[0]
    assert.ok(library, 'library is mounted after opening')
    assert.equal(library.props.scope, 'ui')
    library.props.onSelect(uiVfxCatalog.byId(1))
    assert.deepEqual(committed, [['animationId', '1']])
    tree = render()
    assert.equal(collect(tree, node => node.type?.name === 'UIVfxLibrary').length, 0, 'selection closes the library')
  } finally { restore() }
})

function fakeCanvas() {
  const draws = []
  return {
    width: 0, height: 0, draws,
    getContext(type) {
      if (type !== '2d') return null
      return { drawImage: (...args) => draws.push(args) }
    },
  }
}
function fakeVideo({ width = 100, height = 50, readyState = 4 } = {}) {
  const listeners = new Map()
  return {
    readyState, videoWidth: width, videoHeight: height, currentTime: 0, paused: false, ended: false,
    listeners,
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler) },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler) },
    emit(name) { for (const handler of listeners.get(name) || []) handler() },
  }
}

test('UIVfx renderer splits the packed video into transmission and emission channels', () => {
  const raf = stubAnimationFrame()
  try {
    const video = fakeVideo()
    const transmission = fakeCanvas()
    const emission = fakeCanvas()
    let frames = 0
    const renderer = attachUIVfxRenderer(video, transmission, emission, { onFrame: () => { frames++ } })
    renderer.draw()
    assert.equal(transmission.width, 50)
    assert.equal(emission.width, 50)
    assert.equal(transmission.height, 50)
    assert.deepEqual(transmission.draws.at(-1), [video, 50, 0, 50, 50, 0, 0, 50, 50])
    assert.deepEqual(emission.draws.at(-1), [video, 0, 0, 50, 50, 0, 0, 50, 50])
    assert.equal(frames, 1)
    // The same frame is not re-drawn until the video clock advances.
    renderer.draw()
    assert.equal(frames, 1)
    video.currentTime = 1 / 30
    renderer.draw()
    assert.equal(frames, 2)
    renderer.destroy()
    assert.equal(video.listeners.get('loadeddata').size, 0)
  } finally { raf.restore() }
})

test('UIVfx renderer rejects unsplit frames and unsupported canvases', () => {
  const raf = stubAnimationFrame()
  try {
    const errors = []
    const odd = fakeVideo({ width: 101 })
    const renderer = attachUIVfxRenderer(odd, fakeCanvas(), fakeCanvas(), { onError: () => errors.push(true) })
    renderer.draw()
    assert.equal(errors.length, 1)
    renderer.destroy()

    const notReady = fakeVideo({ readyState: 1 })
    const idle = attachUIVfxRenderer(notReady, fakeCanvas(), fakeCanvas(), { onError: () => errors.push('idle') })
    idle.draw()
    assert.equal(errors.length, 1, 'an unloaded video is not an error')
    idle.destroy()

    assert.throws(() => attachUIVfxRenderer(fakeVideo(), { getContext: () => null }, fakeCanvas()), /不支持 Canvas 2D/)
  } finally { raf.restore() }
})

test('UIVfx renderer stops scheduling frames once the video pauses', () => {
  const raf = stubAnimationFrame()
  try {
    const video = fakeVideo()
    const renderer = attachUIVfxRenderer(video, fakeCanvas(), fakeCanvas())
    video.emit('play')
    assert.equal(raf.scheduled.length, 1)
    video.paused = true
    raf.scheduled.shift()()
    assert.equal(raf.scheduled.length, 0)
    renderer.destroy()
  } finally { raf.restore() }
})

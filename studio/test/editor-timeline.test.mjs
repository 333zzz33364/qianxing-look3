import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView, planKeyframeDrag, collectCrossedAnimationEvents, appendAnimationEventLog } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject, findNode } from '../ui/authoring.js'
import { commitInputDraft, createInputDraft } from '../../editor-ui/input-draft.js'

test('UI06 responsive panel widths respect all collapsed states', () => {
  const previous = globalThis.document
  let css = ''
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({}),
    head: { append: element => { css = element.textContent } },
  }
  try {
    createAnimationView({
      createElement() {},
      useState() {},
      useEffect() {},
      useRef() {},
    }, {}).ensureStyle()
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
  assert.match(css, /@media\(max-width:1050px\)\{\.look2-main\{grid-template-columns:min\(var\(--tree-width/)
  assert.match(css, /@media\(max-width:1100px\)\{\.look2-main\{--responsive-tree:/)
  assert.match(css, /@media\(max-width:820px\)\{\.look2-main\{--responsive-tree:/)
  assert.match(css, /@media\(max-width:520px\)\{\.look2-top\{max-height:96px\}\.look2-main\{--tiny-tree:/)
  assert.match(css, /\.look2-main\.hide-tree\{--responsive-tree:28px\}/)
  assert.match(css, /\.look2-main\.hide-inspector\{--responsive-inspector:28px\}/)
  assert.match(css, /\.look2-main\.hide-animator\.hide-inspector\{--responsive-anim-row:28px\}/)
  assert.match(css, /\.look2-main\.hide-animator\.hide-inspector\{grid-template-rows:minmax\(170px,1fr\) 28px\}/)
  assert.doesNotMatch(css, /\.look2-main\.hide-animator\{(?:--responsive-anim-row|grid-template-rows):/)
  assert.doesNotMatch(css, /\.look2-main\.hide-inspector\{grid-template-columns:/)
  assert.doesNotMatch(css, /\.look2-main\.hide-tree\{grid-template-columns:/)

  const view = editor({ fields: [] })
  for (const [buttonTitle, variable] of [
    ['折叠控件面板', '--tree-width'],
    ['折叠动画面板', '--anim-width'],
    ['收起属性面板', '--inspector-width'],
  ]) {
    const button = view.find(node => node.props.title === buttonTitle)[0]
    assert.ok(button, buttonTitle)
    button.props.onClick()
    assert.equal(view.render().props.style[variable], '28px', variable)
  }
})

// Exercise the actual editor handlers across renders and asynchronous Studio
// transactions. DOM geometry and browser pointer capture are checked separately.
function editor({ asset = 'client', templates = false, fields = ['anchoredPositionX', 'groupAlpha'], values = [], keyTimes = [], events = [], selectedId, syncAllDevices, canvasId, includeEmptyTrack = false } = {}) {
  const studio = createStudio(asset === 'server' ? undefined : createDefaultClientTemplateProject())
  if (canvasId) studio.patch({ op: 'setCanvas', canvasId })
  if (selectedId) studio.patch({ op: 'select', id: selectedId })
  if (syncAllDevices !== undefined) studio.patch({ op: 'set', id: studio.get().selectedId, key: 'syncAllDevices', value: syncAllDevices })
  const state = studio.get().look2
  const animation = state.animations[0]
  animation.duration = 4
  animation.events = structuredClone(events)
  animation.keyframeTracks = fields.map((fieldKey, index) => ({
    id: `track-${index}`, nodeId: studio.get().selectedId, fieldKey,
    keyframes: [{ id: `key-${index}`, time: keyTimes[index] ?? 1, value: values[index] ?? (index ? 128 : 20), easeType: 'Linear', interpolation: 'tween' }],
  }))
  if (includeEmptyTrack) animation.keyframeTracks.push({ id: 'empty-preserved', nodeId: studio.get().selectedId, fieldKey: 'localScaleY', keyframes: [] })
  if (templates) state.controlTemplates.push({ id: 'template-test', name: '旧模板名', index: 1 })
  studio.setLook2(state, studio.get().version)
  const initial = studio.get()
  const slots = []
  let cursor = 0
  let tree
  let pending = null
  let release = null
  let failure = null
  let apiCalls = 0
  let beforeAction
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState(value) {
      const index = cursor++
      if (!(index in slots)) slots[index] = index === 0 ? initial : typeof value === 'function' ? value() : value
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(value) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: index === 1 ? initial : value }
      return slots[index]
    },
    useEffect() {},
    useCallback: callback => { beforeAction = callback; return callback },
  }
  const { AnimationView } = createAnimationView(React, {
    WorkspaceInspector: function WorkspaceInspector() {},
    api: async (_session, action, body) => {
      apiCalls++
      assert.ok(['transaction', 'template'].includes(action))
      if (pending) await pending
      if (failure) { const reason = failure; failure = null; throw reason }
      return action === 'template' ? studio.template(body) : studio.transaction(body)
    },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'timeline-test' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  const keys = () => find(node => /(?:^| )look2-key(?: |$)/.test(node.props.className || ''))
  const key = id => keys().find(node => node.props.key === id)
  function pointer(id, modifiers = {}, delta = 0) {
    const event = { clientX: 100, pointerId: 1, detail: 1, stopPropagation() {}, currentTarget: { setPointerCapture() {} }, ...modifiers }
    key(id).props.onPointerDown(event); render()
    key(id).props.onPointerUp({ ...event, clientX: event.clientX + delta }); render()
    key(id).props.onClick({ ...event, clientX: event.clientX + delta }); render()
  }
  const selected = () => keys().filter(node => node.props.className.includes(' sel')).map(node => node.props.key)
  const button = text => find(node => node.type === 'button' && node.children.includes(text),
    find(node => node.props.className === 'look2-key-inspector')[0])[0]
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); render() }
  render()
  return { studio, render, find, keys, key, pointer, selected, button, flush,
    apiCalls: () => apiCalls,
    beforeAction: () => beforeAction({ blur: false }),
    delay() { pending = new Promise(resolve => { release = resolve }) },
    release() { pending = null; release?.() },
    failNext() { failure = new Error('模拟提交失败') },
  }
}

function workspaceInspector(view) {
  return view.find(node => Object.hasOwn(node.props || {}, 'extraTransformFields'))[0]
}

test('client controls in the full interface expose editable animation tracks without changing asset ownership', async () => {
  const view = editor({ asset: 'server', fields: [], selectedId: 'n2' })
  const before = view.studio.archiveData()
  assert.equal(view.studio.get().asset.type, 'server-control-template')
  assert.ok(view.find(node => node.props['aria-label'] === '关键帧时间轴')[0])
  assert.ok(view.find(node => node.props.title === '新增动画')[0])
  const add = view.find(node => node.props.title === '添加当前控件的轨道')[0]
  assert.equal(add.props.disabled, false)
  add.props.onClick()
  await view.flush()
  const current = view.studio.get()
  assert.equal(current.asset.type, 'server-control-template')
  assert.equal(current.look2.animations[0].keyframeTracks.length, 1)
  assert.equal(current.look2.animations[0].keyframeTracks[0].nodeId, 'n2')
  assert.deepEqual(view.studio.archiveData().assets.client.root, before.assets.client.root,
    'editing a layout control does not move it into the template asset')
  assert.deepEqual(view.studio.archiveData().look2, before.look2,
    'the separate client-template animation state stays unchanged')
  assert.equal(createStudio(view.studio.archiveData()).get().look2.animations[0].keyframeTracks.length, 1)
})

test('full-interface wrapper selections create events on the client root and add ordinary layout containers', async () => {
  const view = editor({ asset: 'server', fields: [], selectedId: 'sc1' })
  const initial = view.studio.get()
  const addTrack = view.find(node => node.props.title === '添加当前控件的轨道')[0]
  assert.equal(addTrack.props.disabled, true)
  view.find(node => node.type === 'button' && node.children.includes('＋ 事件'))[0].props.onClick()
  await view.flush()
  assert.equal(view.studio.get().look2.animations[0].events[0].nodeId, initial.animationPreviewRoot.authoringId)
  const childCount = view.studio.archiveData().assets.server.root.children.length
  view.find(node => node.props.title === '新建容器')[0].props.onClick()
  await view.flush()
  assert.equal(view.studio.get().asset.type, 'server-control-template')
  assert.equal(view.studio.archiveData().assets.server.root.children.length, childCount + 1)
})

test('queued animation edits reject a changed asset even when both assets share the default animation ID', async () => {
  const view = editor({ asset: 'server', fields: [] })
  const before = view.studio.archiveData().look2
  view.delay()
  view.find(node => node.type === 'button' && node.children.includes('客户端模板'))[0].props.onClick()
  view.find(node => node.props.title === '新增动画')[0].props.onClick()
  view.release()
  await view.flush()
  await view.flush()
  assert.equal(view.studio.get().asset.type, 'client-control-template')
  assert.deepEqual(view.studio.get().look2, before)
  assert.equal(view.studio.archiveData().look2ByAsset.server.animations.length, 1)
})

function extraTransformInputs(view) {
  const extra = workspaceInspector(view)?.props.extraTransformFields
  if (!extra) return []
  return view.find(node => node.props?.type === 'number' && typeof node.props.onCommit === 'function', extra)
}

function extraTransformInput(view, section, axis) {
  const label = `${section === 'scale' ? '\u7f29\u653e' : '\u65cb\u8f6c'} ${axis}`
  return extraTransformInputs(view).find(node => node.props.ariaLabel === label)
}

function platformTransform(view, platform) {
  const current = view.studio.get()
  return findNode(current.root, current.selectedId).transformByPlatform[platform]
}

test('keyboard and touchscreen expose five extra transform fields with independent platform edits', async () => {
  const view = editor({ fields: [] })
  const originalCanvas = structuredClone(view.studio.get().canvas)
  const originalCanvasId = view.studio.get().canvasId
  const original = structuredClone(findNode(view.studio.get().root, view.studio.get().selectedId).transformByPlatform)
  const labels = inputs => inputs.map(node => node.props.ariaLabel).sort()
  const expectedExtraLabels = [
    '\u7f29\u653e x', '\u7f29\u653e y', '\u7f29\u653e z',
    '\u65cb\u8f6c x', '\u65cb\u8f6c y',
  ].sort()
  assert.equal(workspaceInspector(view).props.transformPlatform, 'KEYBOARD')
  assert.deepEqual(labels(extraTransformInputs(view)), expectedExtraLabels)

  async function commit(section, axis, value) {
    const input = extraTransformInput(view, section, axis)
    assert.ok(input, `${section}.${axis} should be an AnimationView DraftInput`)
    await input.props.onCommit(value)
    await view.flush()
  }
  await commit('scale', 'x', 1.25)
  await commit('rotation', 'x', 13)

  const picker = workspaceInspector(view).props.transformHeader
  const touchscreen = view.find(node => node.props.key === 'TOUCHSCREEN' && typeof node.props.onClick === 'function', picker)[0]
  assert.ok(touchscreen)
  touchscreen.props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.get().canvas, originalCanvas, 'author platform selection keeps the runtime viewport unchanged')
  assert.equal(view.studio.get().canvasId, originalCanvasId)
  assert.equal(workspaceInspector(view).props.transformPlatform, 'TOUCHSCREEN')
  assert.deepEqual(labels(extraTransformInputs(view)), expectedExtraLabels)
  await commit('scale', 'y', .75)
  await commit('rotation', 'y', -9)

  const expected = structuredClone(original)
  expected.KEYBOARD.scale.x = 1.25
  expected.KEYBOARD.rotation.x = 13
  expected.TOUCHSCREEN.scale.y = .75
  expected.TOUCHSCREEN.rotation.y = -9
  assert.deepEqual(findNode(view.studio.get().root, view.studio.get().selectedId).transformByPlatform, expected)

  const controller = view.find(node => node.props.key === 'CONTROLLER_MOBILE' && typeof node.props.onClick === 'function', picker)[0]
  controller.props.onClick()
  await view.flush()
  assert.equal(workspaceInspector(view).props.transformPlatform, 'CONTROLLER_MOBILE')
  assert.equal(workspaceInspector(view).props.extraTransformFields, null)
  const controllerTransform = view.find(node => node.props.className?.startsWith('look2-platform-transform'))[0]
  assert.equal(view.find(node => node.props.type === 'number' && typeof node.props.onCommit === 'function', controllerTransform).length, 16)
})

test('queued scale X and Y DraftInput commits preserve both axes and support one-step undo and redo', async () => {
  const view = editor({ fields: [] })
  const before = structuredClone(platformTransform(view, 'KEYBOARD'))
  const historyBefore = view.studio.get().history.entries.length
  const xInput = extraTransformInput(view, 'scale', 'x')
  const yInput = extraTransformInput(view, 'scale', 'y')
  assert.ok(xInput)
  assert.ok(yInput)

  view.delay()
  const editX = xInput.props.onCommit(1.4)
  const editY = yInput.props.onCommit(.65)
  await view.flush()
  view.release()
  await Promise.all([editX, editY])
  await view.flush()

  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1.4)
  assert.equal(platformTransform(view, 'KEYBOARD').scale.y, .65)
  assert.equal(platformTransform(view, 'KEYBOARD').scale.z, before.scale.z)
  assert.equal(view.studio.get().history.entries.length, historyBefore + 2)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1.4)
  assert.equal(platformTransform(view, 'KEYBOARD').scale.y, before.scale.y)
  view.studio.history({ action: 'redo', expectedRevision: view.studio.get().version })
  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1.4)
  assert.equal(platformTransform(view, 'KEYBOARD').scale.y, .65)
})

test('scale DraftInput records its existing track and one undo or redo reverses the edit', async () => {
  const view = editor({ fields: ['localScaleX'], values: [1] })
  const seek = view.find(node => node.props.className === 'timeline-seek')[0]
  seek.props.onChange({ target: { value: '2' } })
  view.render()
  const historyBefore = view.studio.get().history.entries.length
  const input = extraTransformInput(view, 'scale', 'x')
  assert.ok(input)
  await input.props.onCommit(1.5)
  await view.flush()

  const readTrack = () => view.studio.get().look2.animations[0].keyframeTracks.find(track => track.fieldKey === 'localScaleX')
  const recorded = readTrack().keyframes.find(key => key.time === 2)
  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1)
  assert.deepEqual({ value: recorded.value, relative: recorded.relative }, { value: 1.5, relative: false })
  assert.equal(view.studio.get().history.entries.length, historyBefore + 1)

  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1)
  assert.equal(readTrack().keyframes.some(key => key.time === 2), false)
  view.studio.history({ action: 'redo', expectedRevision: view.studio.get().version })
  assert.equal(platformTransform(view, 'KEYBOARD').scale.x, 1)
  assert.equal(readTrack().keyframes.find(key => key.time === 2).value, 1.5)
})

test('invalid transform DraftInput values reject before API, project, or history changes', async () => {
  const view = editor({ fields: [] })
  const input = extraTransformInput(view, 'scale', 'z')
  assert.ok(input)
  const archiveBefore = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  const apiCallsBefore = view.apiCalls()
  await assert.rejects(input.props.onCommit(Number.NaN), /\u6709\u9650\u6570\u5b57/)
  assert.equal(view.apiCalls(), apiCallsBefore)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.deepEqual(view.studio.archiveData(), archiveBefore)
})

test('AN03 group drag clamps a shared offset and preserves key spacing', () => {
  const animation = { keyframeTracks: [{ id: 'track-a', keyframes: [
    { id: 'a', time: .5 }, { id: 'b', time: 1.5 },
  ] }, { id: 'track-b', keyframes: [{ id: 'c', time: 3 }] }] }
  const original = structuredClone(animation)
  const selection = [{ trackId: 'track-a', keyId: 'a' }, { trackId: 'track-a', keyId: 'b' }]
  const toEnd = planKeyframeDrag(animation, selection, 20, 4, 30, false)
  assert.deepEqual(toEnd.moves.map(item => item.nextTime), [3, 4])
  assert.equal(toEnd.moves[1].nextTime - toEnd.moves[0].nextTime, 1)
  const toStart = planKeyframeDrag(animation, selection, -20, 4, 30, false)
  assert.deepEqual(toStart.moves.map(item => item.nextTime), [0, 1])
  assert.deepEqual(animation, original, 'planning must not mutate the original animation')
})

test('AN03 group drag snaps translation once and rejects same-track collisions', () => {
  const animation = { keyframeTracks: [{ id: 'track-a', keyframes: [
    { id: 'a', time: .1 }, { id: 'b', time: .23 }, { id: 'c', time: .5 },
  ] }] }
  const selection = [{ trackId: 'track-a', keyId: 'a' }, { trackId: 'track-a', keyId: 'b' }]
  const snapped = planKeyframeDrag(animation, selection, .28, 4, 30, true)
  assert.deepEqual(snapped.moves.map(item => item.nextTime), [.3667, .4967])
  assert.equal(Number((snapped.moves[1].nextTime - snapped.moves[0].nextTime).toFixed(4)), .13)
  const collision = planKeyframeDrag(animation, [{ trackId: 'track-a', keyId: 'a' }], .4, 4, 30, false)
  assert.match(collision.error, /重叠/)
  assert.deepEqual(collision.moves, [])
  assert.deepEqual(animation.keyframeTracks[0].keyframes.map(item => item.time), [.1, .23, .5])
})

test('AN03 real handler preserves multi-key spacing at the duration boundary and undoes once', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  const seek = view.find(node => node.props.className === 'timeline-seek')[0]
  seek.props.onChange({ target: { value: '3' } }); view.render()
  view.find(node => node.props.title === '在播放头添加关键帧')[0].props.onClick()
  await view.flush()
  const animation = () => view.studio.get().look2.animations[0]
  assert.deepEqual(animation().keyframeTracks[0].keyframes.map(key => key.time), [1, 3])
  view.pointer('key-0', { ctrlKey: true })
  const beforeHistory = view.studio.get().history.entries.length
  view.pointer('key-0', {}, 160)
  await view.flush()
  assert.deepEqual(animation().keyframeTracks[0].keyframes.map(key => key.time), [2, 4])
  assert.equal(view.studio.get().history.entries.length, beforeHistory + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.deepEqual(animation().keyframeTracks[0].keyframes.map(key => key.time), [1, 3])
})

test('AN01 duplicate animation isolates IDs and edits, and failed duplication preserves the playhead', async () => {
  const view = editor({ fields: ['anchoredPositionX'], events: [
    { id: 'source-event', time: 2, name: '原事件', nodeId: '', target: '', params: '{"source":true}' },
  ] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const duplicate = () => view.find(node => node.props.title === '复制动画')[0]
  const before = view.studio.archiveData()
  const previousHistory = view.studio.get().history.entries.length
  view.failNext()
  duplicate().props.onClick()
  await view.flush()
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, previousHistory)
  duplicate().props.onClick()
  await view.flush()
  const animations = () => view.studio.get().look2.animations
  assert.equal(animations().length, 2)
  const [original, copy] = animations()
  const originalId = original.id
  const copyId = copy.id
  assert.notEqual(original.id, copy.id)
  assert.notEqual(original.keyframeTracks[0].id, copy.keyframeTracks[0].id)
  assert.notEqual(original.keyframeTracks[0].keyframes[0].id, copy.keyframeTracks[0].keyframes[0].id)
  assert.equal(original.events.length, 1)
  assert.equal(copy.events.length, 1)
  assert.notEqual(original.events[0].id, copy.events[0].id)
  assert.deepEqual(copy.events[0], { ...original.events[0], id: copy.events[0].id })

  const copiedEventId = copy.events[0].id
  view.find(node => node.props.className === 'look2-event-dot' && node.props.key === copiedEventId)[0].props.onClick()
  view.render()
  view.find(node => node.props.key === `${copiedEventId}:name`)[0].props.onBlur({ target: { value: '副本事件' } })
  await view.flush()
  const currentAnimation = id => animations().find(animation => animation.id === id)
  assert.equal(currentAnimation(originalId).events[0].name, '原事件')
  assert.equal(currentAnimation(copyId).events[0].name, '副本事件')

  view.pointer(copy.keyframeTracks[0].keyframes[0].id)
  await view.find(node => node.props.ariaLabel === '关键帧属性值')[0].props.onCommit(50)
  await view.flush()
  assert.equal(currentAnimation(originalId).keyframeTracks[0].keyframes[0].value, 20)
  assert.equal(currentAnimation(copyId).keyframeTracks[0].keyframes[0].value, 50)

  const inspector = view.find(node => node.props.className === 'look2-inspector')[0]
  const deleteCopy = view.find(node => node.type === 'button' && node.children.includes('删除'), inspector)[0]
  const beforeDeleteHistory = view.studio.get().history.entries.length
  deleteCopy.props.onClick()
  await view.flush()
  assert.deepEqual(animations().map(animation => animation.id), [originalId])
  assert.equal(view.studio.get().history.entries.length, beforeDeleteHistory + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.deepEqual(animations().map(animation => animation.id).sort(), [originalId, copyId].sort())
  assert.equal(currentAnimation(originalId).events[0].name, '原事件')
  assert.equal(currentAnimation(copyId).events[0].name, '副本事件')
  assert.equal(currentAnimation(originalId).keyframeTracks[0].keyframes[0].value, 20)
  assert.equal(currentAnimation(copyId).keyframeTracks[0].keyframes[0].value, 50)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(currentAnimation(originalId).keyframeTracks[0].keyframes[0].value, 20)
  assert.equal(currentAnimation(copyId).keyframeTracks[0].keyframes[0].value, 20)
  assert.equal(currentAnimation(copyId).events[0].name, '副本事件')
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(currentAnimation(originalId).events[0].name, '原事件')
  assert.equal(currentAnimation(copyId).events[0].name, '原事件')
})

test('AN01 deleting a copied animation keeps the original and Undo restores the copy', async () => {
  const oldWindow = globalThis.window
  globalThis.window = { innerWidth: 1280, innerHeight: 720 }
  try {
    const view = editor({ fields: ['anchoredPositionX'], events: [
      { id: 'event-original', time: 1, name: '事件', nodeId: '', target: '', params: '' },
    ] })
    const originalId = view.studio.get().look2.animations[0].id
    view.find(node => node.props.title === '复制动画')[0].props.onClick()
    await view.flush()
    const animations = () => view.studio.get().look2.animations
    assert.equal(animations().length, 2)
    const copyId = animations()[1].id
    assert.notEqual(copyId, originalId)
    const historyBefore = view.studio.get().history.entries.length
    const copyRow = view.find(node => node.props.className === 'look2-anim-row' && node.props.key === copyId)[0]
    assert.ok(copyRow)
    copyRow.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 })
    view.render()
    const menu = view.find(node => node.props.className === 'look2-context-menu')[0]
    assert.ok(menu)
    const remove = view.find(node => node.type === 'button' && node.children.includes('删除动画'), menu)[0]
    assert.ok(remove)
    remove.props.onClick()
    await view.flush()
    assert.deepEqual(animations().map(animation => animation.id), [originalId])
    assert.equal(view.studio.get().look2.activeAnimationId, originalId)
    assert.equal(view.studio.get().history.entries.length, historyBefore + 1)
    view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
    assert.deepEqual(animations().map(animation => animation.id), [originalId, copyId])
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
})

test('AN01 deleting an inactive animation preserves the current playhead and key selection', async () => {
  const oldWindow = globalThis.window
  globalThis.window = { innerWidth: 1280, innerHeight: 720 }
  try {
    const view = editor({ fields: ['anchoredPositionX'] })
    view.find(node => node.props.title === '复制动画')[0].props.onClick()
    await view.flush()
    const [original, copy] = view.studio.get().look2.animations
    view.find(node => node.props.title === `${original.name} · ${original.duration}s`)[0].props.onClick()
    await view.flush()
    view.pointer('key-0')
    view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
    view.render()
    const inactive = view.find(node => node.props.className === 'look2-anim-row' && node.props.key === copy.id)[0]
    assert.ok(inactive)
    inactive.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 })
    view.render()
    const menu = view.find(node => node.props.className === 'look2-context-menu')[0]
    assert.ok(menu)
    const remove = view.find(node => node.type === 'button' && node.children.includes('删除动画'), menu)[0]
    assert.ok(remove)
    remove.props.onClick()
    await view.flush()
    assert.deepEqual(view.studio.get().look2.animations.map(animation => animation.id), [original.id])
    assert.equal(view.studio.get().look2.activeAnimationId, original.id)
    assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
    assert.deepEqual(view.selected(), ['key-0'])
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
})

test('AN01 adding animation changes playhead and selection only after successful transaction', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  view.pointer('key-0')
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  const add = () => view.find(node => node.props.title === '新增动画')[0]
  assert.ok(add())

  view.failNext()
  add().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.deepEqual(view.selected(), ['key-0'])
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.equal(view.studio.get().history.entries.length, historyBefore)

  add().props.onClick()
  await view.flush()
  const state = view.studio.get().look2
  assert.equal(state.animations.length, 2)
  assert.equal(state.activeAnimationId, state.animations[1].id)
  assert.deepEqual(view.selected(), [])
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 0)
  assert.equal(view.studio.get().history.entries.length, historyBefore + 1)
})

test('AN01 reselecting the active animation keeps playhead selection and history unchanged', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  view.pointer('key-0')
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const active = view.studio.get().look2.animations[0]
  const historyBefore = view.studio.get().history.entries.length
  const apiBefore = view.apiCalls()
  const before = view.studio.archiveData()
  const button = view.find(node => node.type === 'button' && node.props.title === `${active.name} · ${active.duration}s`)[0]
  assert.ok(button)
  button.props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.equal(view.apiCalls(), apiBefore)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.deepEqual(view.selected(), ['key-0'])
})

test('AN01 failed animation switch keeps the playhead and selection until the transaction succeeds', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  view.find(node => node.props.title === '复制动画')[0].props.onClick()
  await view.flush()
  const animations = view.studio.get().look2.animations
  assert.equal(animations.length, 2)
  const [original, copy] = animations
  assert.equal(view.studio.get().look2.activeAnimationId, copy.id)
  view.pointer(copy.keyframeTracks[0].keyframes[0].id)
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()

  const switchToOriginal = () => view.find(node => node.type === 'button' && node.props.title === `${original.name} · ${original.duration}s`)[0]
  assert.ok(switchToOriginal())
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  view.failNext()
  switchToOriginal().props.onClick()
  await view.flush()
  assert.equal(view.studio.get().look2.activeAnimationId, copy.id)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.ok(view.selected().includes(copy.keyframeTracks[0].keyframes[0].id))

  switchToOriginal().props.onClick()
  await view.flush()
  assert.equal(view.studio.get().look2.activeAnimationId, original.id)
  assert.equal(view.studio.get().history.entries.length, historyBefore + 1)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 0)
  assert.deepEqual(view.selected(), [])
})

test('AN03 add and remove track only update selection after a successful transaction', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  view.pointer('key-0')
  const fieldPicker = view.find(node => node.props.title === '新建轨道属性')[0]
  fieldPicker.props.onChange({ target: { value: 'groupAlpha' } })
  view.render()
  const add = () => view.find(node => node.props.title === '添加当前控件的轨道')[0]
  const tracks = () => view.studio.get().look2.animations[0].keyframeTracks
  const before = view.studio.archiveData()
  view.failNext()
  add().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.deepEqual(view.selected(), ['key-0'])

  add().props.onClick()
  await view.flush()
  const newTrack = tracks().find(track => track.fieldKey === 'groupAlpha')
  assert.ok(newTrack)
  const newKeyId = newTrack.keyframes[0].id
  assert.deepEqual(view.selected(), [newKeyId])
  const remove = () => view.find(node => node.props.className === 'look2-track-name' && node.props.title === '组合透明度')[0]
    .children.find(node => node?.props?.title === '删除轨道')
  assert.ok(remove())
  const afterAdd = view.studio.archiveData()
  view.failNext()
  remove().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), afterAdd)
  assert.deepEqual(view.selected(), [newKeyId])

  remove().props.onClick()
  await view.flush()
  assert.equal(tracks().some(track => track.id === newTrack.id), false)
  assert.equal(tracks().length, 1)
  assert.deepEqual(view.selected(), [])
})

test('AN03 adding an existing field track selects its key without creating a history entry', () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  const before = view.studio.archiveData()
  const oldHistory = view.studio.get().history.entries.length
  const oldCalls = view.apiCalls()
  const add = view.find(node => node.props.title === '添加当前控件的轨道')[0]
  assert.ok(add)
  add.props.onClick()
  view.render()
  assert.deepEqual(view.selected(), ['key-0'])
  assert.equal(view.studio.get().history.entries.length, oldHistory)
  assert.equal(view.apiCalls(), oldCalls)
  assert.deepEqual(view.studio.archiveData(), before)
})

test('AN03 lane insertion applies its seek only after the keyframe transaction succeeds', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  const lane = () => view.find(node => node.props.className === 'look2-track-lane')[0]
  const doubleClick = { clientX: 160, currentTarget: { getBoundingClientRect: () => ({ left: 0 }) } }
  const seek = () => view.find(node => node.props.className === 'timeline-seek')[0].props.value
  assert.equal(seek(), 0)
  const archive = view.studio.archiveData()
  view.failNext()
  lane().props.onDoubleClick(doubleClick)
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), archive)
  assert.equal(seek(), 0)
  lane().props.onDoubleClick(doubleClick)
  await view.flush()
  assert.equal(seek(), 2)
  assert.ok(view.studio.get().look2.animations[0].keyframeTracks[0].keyframes.some(item => item.time === 2))
})

test('AN07 event lane insertion applies its seek only after the event transaction succeeds', async () => {
  const view = editor({ fields: [] })
  const lane = () => view.find(node => node.props.className === 'look2-event-lane')[0]
  const doubleClick = { clientX: 160, currentTarget: { getBoundingClientRect: () => ({ left: 0 }) } }
  const seek = () => view.find(node => node.props.className === 'timeline-seek')[0].props.value
  const archive = view.studio.archiveData()
  view.failNext()
  lane().props.onDoubleClick(doubleClick)
  await view.flush()
  assert.equal(seek(), 0)
  assert.deepEqual(view.studio.archiveData(), archive)
  lane().props.onDoubleClick(doubleClick)
  await view.flush()
  assert.equal(seek(), 2)
  assert.equal(view.studio.get().look2.animations[0].events.length, 1)
  assert.equal(view.studio.get().look2.animations[0].events[0].time, 2)
})

test('AN03 removing a selected key preserves unrelated pre-existing empty tracks', async () => {
  const view = editor({ fields: ['anchoredPositionX'], includeEmptyTrack: true })
  const tracks = () => view.studio.get().look2.animations[0].keyframeTracks
  assert.deepEqual(tracks().map(track => track.id), ['track-0', 'empty-preserved'])
  view.pointer('key-0')
  assert.deepEqual(view.selected(), ['key-0'])
  view.button('删除').props.onClick()
  await view.flush()
  assert.deepEqual(tracks().map(track => track.id), ['empty-preserved'])
  assert.deepEqual(tracks()[0].keyframes, [])
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.deepEqual(tracks().map(track => track.id), ['track-0', 'empty-preserved'])
})

test('AN03 keyframe add and delete retain selection and history after a rejected transaction', async () => {
  const view = editor({ fields: ['anchoredPositionX'] })
  view.pointer('key-0')
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const addKey = () => view.find(node => node.props.title === '在播放头添加关键帧')[0]
  const keys = () => view.studio.get().look2.animations[0].keyframeTracks[0].keyframes
  const original = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length

  view.failNext()
  addKey().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), original)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.deepEqual(view.selected(), ['key-0'])

  addKey().props.onClick()
  await view.flush()
  const inserted = keys().find(key => key.time === 2)
  assert.ok(inserted)
  assert.deepEqual(view.selected(), [inserted.id])
  assert.equal(view.studio.get().history.entries.length, historyBefore + 1)

  const deleteKey = () => view.find(node => node.type === 'button' && node.children.some(child => typeof child === 'string' && child.startsWith('删除')),
    view.find(node => node.props.className === 'look2-key-inspector')[0])[0]
  assert.ok(deleteKey())
  const saved = view.studio.archiveData()
  const historyAfterInsert = view.studio.get().history.entries.length
  view.failNext()
  deleteKey().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), saved)
  assert.deepEqual(view.selected(), [inserted.id])
  assert.equal(view.studio.get().history.entries.length, historyAfterInsert)

  deleteKey().props.onClick()
  await view.flush()
  assert.equal(keys().some(key => key.id === inserted.id), false)
  assert.deepEqual(view.selected(), [])
  assert.equal(view.studio.get().history.entries.length, historyAfterInsert + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(keys().some(key => key.id === inserted.id), true)
})

test('AN07 event add and delete preserve the previously selected event on failed transactions', async () => {
  const view = editor({ fields: [], events: [
    { id: 'event-existing', time: 1, name: '已存在事件', nodeId: '', target: '', params: '' },
  ] })
  const events = () => view.studio.get().look2.animations[0].events
  view.find(node => node.props.className === 'look2-event-dot' && node.props.key === 'event-existing')[0].props.onClick()
  view.render()
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const add = () => view.find(node => node.props.title === '在播放头添加事件')[0]
  const old = view.studio.archiveData()
  const beforeHistory = view.studio.get().history.entries.length

  view.failNext()
  add().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), old)
  assert.equal(view.studio.get().history.entries.length, beforeHistory)
  assert.ok(view.find(node => node.props.key === 'event-existing:name')[0])

  add().props.onClick()
  await view.flush()
  const created = events().find(event => event.id !== 'event-existing')
  assert.ok(created)
  assert.equal(created.time, 2)
  assert.ok(view.find(node => node.props.key === `${created.id}:name`)[0])

  const remove = () => view.find(node => node.type === 'button' && node.children.includes('删除事件'))[0]
  const afterAdd = view.studio.archiveData()
  const beforeDeleteHistory = view.studio.get().history.entries.length
  view.failNext()
  remove().props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), afterAdd)
  assert.equal(view.studio.get().history.entries.length, beforeDeleteHistory)
  assert.ok(view.find(node => node.props.key === `${created.id}:name`)[0])

  remove().props.onClick()
  await view.flush()
  assert.equal(events().length, 1)
  assert.equal(events()[0].id, 'event-existing')
  assert.equal(view.find(node => node.props.key === `${created.id}:name`).length, 0)
  assert.equal(view.studio.get().history.entries.length, beforeDeleteHistory + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(events().length, 2)
})

test('AN02 group collapse and timeline transport controls keep editing state', async () => {
  const view = editor()
  const tracks = () => view.find(node => node.props.className === 'look2-track')
  assert.equal(tracks().length, 2)
  const group = () => view.find(node => node.props.className === 'look2-track-group')[0]
  assert.ok(group())
  group().children[0].props.onClick()
  view.render()
  assert.equal(tracks().length, 0)
  group().children[0].props.onClick()
  view.render()
  assert.equal(tracks().length, 2)

  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  const transport = () => view.find(node => node.props.title === '播放或暂停')[0]
  assert.equal(transport().props['aria-pressed'], false)
  transport().props.onClick()
  view.render()
  assert.equal(transport().props['aria-pressed'], true)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  transport().props.onClick()
  view.render()
  assert.equal(transport().props['aria-pressed'], false)
  view.find(node => node.props.title === '回到起点')[0].props.onClick()
  view.render()
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 0)
  assert.equal(transport().props['aria-pressed'], false)
})

test('ST02 new document resets timeline selection only after successful commit', async () => {
  const previousDocument = globalThis.document
  globalThis.document = { activeElement: null }
  try {
    const view = editor({ fields: ['anchoredPositionX'], events: [
      { id: 'keep-event', time: 1, name: '事件', nodeId: '', target: '', params: '' },
    ] })
    view.pointer('key-0')
    view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
    view.render()
    const create = () => view.find(node => node.props.title === '新建工程')[0]
    assert.ok(create())
    const oldArchive = view.studio.archiveData()
    view.failNext()
    create().props.onClick()
    await view.flush()
    assert.deepEqual(view.studio.archiveData(), oldArchive)
    assert.deepEqual(view.selected(), ['key-0'])
    assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)

    // beforeAction guards unresolved failures. Exercise the successful branch
    // in a separate session without bypassing that safety rule.
    const clean = editor({ fields: ['anchoredPositionX'], events: [
      { id: 'keep-event', time: 1, name: '事件', nodeId: '', target: '', params: '' },
    ] })
    clean.pointer('key-0')
    clean.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
    clean.render()
    clean.find(node => node.props.title === '新建工程')[0].props.onClick()
    await clean.flush()
    assert.equal(clean.find(node => node.props.className === 'timeline-seek')[0].props.value, 0)
    assert.deepEqual(clean.selected(), [])
    assert.equal(clean.studio.get().look2.animations[0].events.length, 0)
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('ST02 project name commits as one undoable edit and a failed rename preserves the archive', async () => {
  const view = editor({ fields: [] })
  view.find(node => node.props.title === '工作区存档')[0].props.onClick()
  view.render()
  const nameInput = () => view.find(node => node.props.ariaLabel === '工程名称')[0]
  assert.ok(nameInput(), 'workspace exposes a project name draft')
  const before = view.studio.archiveData()
  const originalName = view.studio.get().save.name
  const historyBefore = view.studio.get().history.entries.length

  view.failNext()
  await assert.rejects(nameInput().props.onCommit('失败改名'), /模拟提交失败/)
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(nameInput().props.value, originalName)
  assert.equal(view.studio.get().history.entries.length, historyBefore)

  const renamed = await nameInput().props.onCommit('  名称回读验收  ')
  await view.flush()
  assert.equal(view.studio.get().save.name, '名称回读验收')
  assert.equal(view.studio.archiveData().meta.name, '名称回读验收')
  assert.equal(nameInput().props.readCommitted(renamed), '名称回读验收')
  assert.equal(view.studio.get().history.entries.length, historyBefore + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(view.studio.get().save.name, originalName)
  view.studio.history({ action: 'redo', expectedRevision: view.studio.get().version })
  assert.equal(view.studio.archiveData().meta.name, '名称回读验收')
})

test('ST02 blank project name retains committed data and Escape releases the failed input barrier', async () => {
  const view = editor({ fields: [] })
  view.find(node => node.props.title === '工作区存档')[0].props.onClick()
  view.render()
  const name = view.find(node => node.props.ariaLabel === '工程名称')[0]
  assert.ok(name)
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  const draft = createInputDraft(name.props.value, { onDiscardError: name.props.onDiscardError })
  draft.edit('   ')
  const result = await commitInputDraft(draft, value => name.props.onCommit(value))
  assert.equal(result.ok, false)
  await assert.rejects(view.beforeAction(), /存档名称不能为空/)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  draft.reset(name.props.value)
  await view.beforeAction()
  assert.deepEqual(view.studio.archiveData(), before)
})

test('AN02 shortening duration clamps the playhead only after a successful transaction', async () => {
  const view = editor({ fields: [] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '3' } })
  view.render()
  const duration = view.find(node => node.props.ariaLabel === '时长 (s)')[0]
  assert.ok(duration)
  const beforeHistory = view.studio.get().history.entries.length
  await duration.props.onCommit(2)
  await view.flush()
  assert.equal(view.studio.get().look2.animations[0].duration, 2)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.equal(view.studio.get().history.entries.length, beforeHistory + 1)
  await assert.rejects(view.find(node => node.props.ariaLabel === '时长 (s)')[0].props.onCommit(.05), /0.1/)
  await view.flush()
  assert.equal(view.studio.get().look2.animations[0].duration, 2)
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 2)
  assert.equal(view.studio.get().history.entries.length, beforeHistory + 1)
})

test('AN02 a rejected duration transaction preserves the playhead, archive, and history', async () => {
  const view = editor({ fields: [] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '3' } })
  view.render()
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  view.failNext()
  await assert.rejects(view.find(node => node.props.ariaLabel === '时长 (s)')[0].props.onCommit(2), /模拟提交失败/)
  await view.flush()
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 3)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
})

test('AN02 shortening past an existing keyframe rejects without changing data or playhead', async () => {
  const view = editor({ fields: ['anchoredPositionX'], keyTimes: [3] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '3' } })
  view.render()
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  await assert.rejects(view.find(node => node.props.ariaLabel === '时长 (s)')[0].props.onCommit(2))
  await view.flush()
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 3)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
})

test('AN02 shortening past an existing event rejects without changing data or playhead', async () => {
  const lateEvent = { id: 'late-event', time: 3, name: '晚事件', nodeId: '', target: '', params: '' }
  const view = editor({ fields: [], events: [lateEvent] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '3' } })
  view.render()
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  await assert.rejects(view.find(node => node.props.ariaLabel === '时长 (s)')[0].props.onCommit(2))
  await view.flush()
  assert.equal(view.find(node => node.props.className === 'timeline-seek')[0].props.value, 3)
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
})

test('AN07 playback event selection is time ordered and includes start exactly once', () => {
  const events = [
    { id: 'late', time: 1 }, { id: 'first', time: 0 }, { id: 'same-1', time: .5 },
    { id: 'same-2', time: .5 }, { id: 'invalid', time: 'invalid' },
  ]
  const first = collectCrossedAnimationEvents(events, 0, .5, true)
  assert.deepEqual(first.map(row => row.id), ['first', 'same-1', 'same-2'])
  assert.deepEqual(collectCrossedAnimationEvents(events, 0, .5, false).map(row => row.id), ['same-1', 'same-2'])
  assert.deepEqual(collectCrossedAnimationEvents(events, .5, 1).map(row => row.id), ['late'])
  assert.deepEqual(collectCrossedAnimationEvents(events, 1, .5), [])
  assert.deepEqual(collectCrossedAnimationEvents(events, 1, 1), [])
})

test('AN07 log retains only latest 50 events in deterministic order', () => {
  const events = Array.from({ length: 55 }, (_, index) => ({ id: `e-${index}`, name: `event-${index}`, time: index / 100 }))
  const crossed = collectCrossedAnimationEvents(events, 0, 1, true)
  const log = appendAnimationEventLog([], crossed, 123)
  assert.equal(log.length, 50)
  assert.equal(log[0].id, 'e-5')
  assert.equal(log[49].id, 'e-54')
  assert.ok(log.every(event => event.at === 123))
  assert.deepEqual(appendAnimationEventLog(log, [], 456), log)
})

test('AN07 actual add-event button uses playhead, unchanged blur makes no transaction, and delete is undoable', async () => {
  const view = editor({ fields: [] })
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } })
  view.render()
  view.find(node => node.props.title === '在播放头添加事件')[0].props.onClick({ type: 'click' })
  await view.flush()
  const animation = () => view.studio.get().look2.animations[0]
  assert.equal(animation().events.length, 1)
  assert.equal(animation().events[0].time, 2, 'button must not pass a click object as event time')
  const eventId = animation().events[0].id
  const paramsInput = () => view.find(node => node.props.key === `${eventId}:params`)[0]
  const nameInput = () => view.find(node => node.props.key === `${eventId}:name`)[0]
  assert.ok(paramsInput())
  const previousCalls = view.apiCalls()
  const history = view.studio.get().history.entries.length
  paramsInput().props.onBlur({ target: { value: '' } })
  nameInput().props.onBlur({ target: { value: '' } })
  await view.flush()
  assert.equal(view.apiCalls(), previousCalls)
  assert.equal(view.studio.get().history.entries.length, history)
  nameInput().props.onBlur({ target: { value: '新事件' } })
  await view.flush()
  assert.equal(animation().events[0].name, '新事件')
  paramsInput().props.onBlur({ target: { value: '{"ok":true}' } })
  await view.flush()
  assert.equal(animation().events[0].params, '{"ok":true}')
  const historyAfterEdit = view.studio.get().history.entries.length
  view.find(node => node.type === 'button' && node.children.includes('删除事件'))[0].props.onClick()
  await view.flush()
  assert.equal(animation().events.length, 0)
  assert.equal(view.studio.get().history.entries.length, historyAfterEdit + 1)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(animation().events[0].id, eventId)
})

test('AN07 empty and over-320-byte UTF-8 names leave the event and history unchanged', async () => {
  const view = editor({ fields: [], events: [
    { id: 'name-event', time: 1, name: '保留名称', nodeId: '', target: '', params: '' },
  ] })
  const eventId = 'name-event'
  view.find(node => node.props.className === 'look2-event-dot' && node.props.key === eventId)[0].props.onClick()
  view.render()
  const before = view.studio.archiveData()
  const historyBefore = view.studio.get().history.entries.length
  const apiCallsBefore = view.apiCalls()
  const nameInput = () => view.find(node => node.props.key === `${eventId}:name`)[0]

  nameInput().props.onBlur({ target: { value: '' } })
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.equal(view.apiCalls(), apiCallsBefore)

  const tooLongName = '中'.repeat(107)
  assert.equal(new TextEncoder().encode(tooLongName).length, 321)
  nameInput().props.onBlur({ target: { value: tooLongName } })
  await view.flush()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, historyBefore)
  assert.equal(view.apiCalls(), apiCallsBefore)
})

test('modifier click toggles each key once and dragging a selected key preserves the group', async () => {
  const view = editor()
  view.pointer('key-0')
  view.pointer('key-1', { ctrlKey: true })
  assert.deepEqual(view.selected().sort(), ['key-0', 'key-1'])
  view.pointer('key-1', { ctrlKey: true })
  assert.deepEqual(view.selected(), ['key-0'])
  view.pointer('key-1', { shiftKey: true })
  view.pointer('key-0', {}, 40)
  await view.flush()
  assert.deepEqual(view.selected().sort(), ['key-0', 'key-1'])
  const tracks = view.studio.get().look2.animations[0].keyframeTracks
  assert.deepEqual(tracks.map(track => track.keyframes[0].time), [1.5, 1.5])
})

test('queued base Inspector X and Y edits retain both transform axes and both recorded tracks', async () => {
  async function editAxes(view, delayed) {
    const current = view.studio.get()
    const inspector = view.find(node => typeof node.props.applyFieldGroup === 'function')[0]
    const values = Object.fromEntries(current.inspector.fields.map(field => [field.key, field.value]))
    const target = { id: current.selectedId, assetType: current.asset.type, kind: current.inspector.kind, platform: current.canvas.platform }
    if (delayed) view.delay()
    const first = inspector.props.applyFieldGroup({ ...target, values: { posX: values.posX + 12 }, label: '设置 位置 X' })
    if (!delayed) await first
    const second = inspector.props.applyFieldGroup({ ...target, values: { posY: values.posY + 9 }, label: '设置 位置 Y' })
    if (delayed) { await view.flush(); view.release() }
    await Promise.all([first, second])
    return view.studio.get()
  }
  const normalize = state => {
    const result = structuredClone(state)
    for (const animation of result.animations) for (const track of animation.keyframeTracks) {
      for (const key of track.keyframes) key.id = `${track.id}@${key.time}`
    }
    return result
  }
  for (const fields of [[], ['anchoredPositionX', 'anchoredPositionY']]) {
    const expected = await editAxes(editor({ fields }), false)
    const actual = await editAxes(editor({ fields }), true)
    assert.deepEqual(actual.root, expected.root)
    assert.deepEqual(normalize(actual.look2), normalize(expected.look2))
  }
})

test('group paste preserves controller transforms with unchanged or changed device sync flags', async () => {
  const nodeById = (root, id) => root.id === id ? root : (root.children || []).map(child => nodeById(child, id)).find(Boolean)
  for (const initialSync of [false, true]) for (const copiedSync of [false, true]) {
    const view = editor({ fields: [], selectedId: 'n3', syncAllDevices: initialSync })
    view.find(node => node.type === 'button' && node.props.key === 'CONTROLLER_MOBILE', workspaceInspector(view).props.transformHeader)[0].props.onClick()
    view.render()
    const current = view.studio.get()
    const before = structuredClone(nodeById(current.root, current.selectedId).transformByPlatform)
    const transform = structuredClone(before.CONTROLLER_MOBILE)
    transform.scale.z = 1.25
    transform.rotation.x = 13
    transform.rotation.y = -17
    transform.offset = { x: 460, y: 160 }
    const historyBefore = current.history.entries.length
    const inspector = view.find(node => typeof node.props.applyFieldGroup === 'function')[0]
    const paste = () => inspector.props.applyFieldGroup({
      id: current.selectedId, assetType: current.asset.type, kind: current.inspector.kind,
      platform: 'CONTROLLER_MOBILE', values: { __transform: transform, syncAllDevices: copiedSync }, label: '粘贴变换属性组',
    })
    await paste()
    const after = nodeById(view.studio.get().root, current.selectedId)
    assert.deepEqual(after.transformByPlatform.CONTROLLER_MOBILE, transform)
    assert.equal(after.syncAllDevices, copiedSync)
    if (initialSync === copiedSync || copiedSync === false) {
      for (const platform of Object.keys(before).filter(value => value !== 'CONTROLLER_MOBILE')) {
        assert.deepEqual(after.transformByPlatform[platform], before[platform], `${platform} must remain unchanged`)
      }
    }
    assert.equal(view.studio.get().history.entries.length, historyBefore + 1)
    view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
    const undone = nodeById(view.studio.get().root, current.selectedId)
    assert.deepEqual(undone.transformByPlatform, before)
    assert.equal(undone.syncAllDevices, initialSync)
    view.studio.history({ action: 'redo', expectedRevision: view.studio.get().version })
    const redone = nodeById(view.studio.get().root, current.selectedId)
    assert.deepEqual(redone.transformByPlatform.CONTROLLER_MOBILE, transform)
    assert.equal(redone.syncAllDevices, copiedSync)
  }
})

test('Escape after failed duration commit releases the action barrier without a retry transaction', async () => {
  const view = editor()
  const duration = view.find(node => node.props.ariaLabel === '时长 (s)')[0]
  const draft = createInputDraft('4', { onDiscardError: duration.props.onDiscardError })
  draft.edit('4.9')
  const before = view.studio.archiveData()
  const history = view.studio.get().history.entries.length
  view.failNext()
  const result = await commitInputDraft(draft, value => duration.props.onCommit(Number(value)))
  assert.equal(result.ok, false)
  await assert.rejects(view.beforeAction(), /模拟提交失败/)
  draft.reset('4')
  await view.beforeAction()
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, history)
})

test('cancelling one failed input cannot release a different input\'s action barrier', async () => {
  const view = editor({ templates: true })
  const duration = view.find(node => node.props.ariaLabel === '时长 (s)')[0]
  const draft = createInputDraft('4', { onDiscardError: duration.props.onDiscardError })
  draft.edit('4.9')
  view.failNext()
  await commitInputDraft(draft, value => duration.props.onCommit(Number(value)))
  view.find(node => node.type === 'button' && node.props.title === '控件模板')[0].props.onClick()
  view.render()
  const name = view.find(node => node.props.ariaLabel === '旧模板名名称')[0]
  const otherDraft = createInputDraft('旧模板名', { onDiscardError: name.props.onDiscardError })
  otherDraft.edit('失败模板名')
  view.failNext()
  await commitInputDraft(otherDraft, value => name.props.onCommit(value))
  draft.reset('4')
  await assert.rejects(view.beforeAction(), /模拟提交失败/)
  otherDraft.reset('旧模板名')
  await view.beforeAction()
})

test('paste selects new keys only after the queued transaction succeeds and delete keeps originals', async () => {
  const view = editor()
  view.pointer('key-0')
  view.button('复制').props.onClick()
  view.render()
  const seek = view.find(node => node.props.className === 'timeline-seek')[0]
  seek.props.onChange({ target: { value: '2' } }); view.render()
  view.delay()
  view.button('粘贴').props.onClick()
  await view.flush()
  assert.deepEqual(view.selected(), ['key-0'])
  view.release()
  await view.flush()
  const pasted = view.studio.get().look2.animations[0].keyframeTracks[0].keyframes.find(key => key.time === 2)
  assert.ok(pasted)
  assert.deepEqual(view.selected(), [pasted.id])
  view.button('删除').props.onClick()
  await view.flush()
  assert.deepEqual(view.studio.get().look2.animations[0].keyframeTracks[0].keyframes.map(key => key.id), ['key-0'])
})

test('queued template name and index edits retain both values when the first reply is delayed', async () => {
  const view = editor({ templates: true })
  view.find(node => node.type === 'button' && node.props.title === '控件模板')[0].props.onClick()
  view.render()
  const row = view.find(node => node.props.className === 'look2-template-row')[0]
  const name = view.find(node => node.props['aria-label'] === '旧模板名名称' || node.props.ariaLabel === '旧模板名名称', row)[0]
  const index = view.find(node => node.props.type === 'number', row)[0]
  view.delay()
  if (name.props.onCommit) void name.props.onCommit('新模板名')
  else name.props.onBlur({ target: { value: '新模板名' } })
  if (index.props.onCommit) void index.props.onCommit(12)
  else index.props.onBlur({ target: { value: '12' } })
  await view.flush()
  view.release()
  await view.flush()
  const saved = view.studio.get().look2.controlTemplates[0]
  assert.equal(saved.name, '新模板名')
  assert.equal(saved.index, 12)
})

test('failed paste keeps the original selection and history; retry selects the new key', async () => {
  const view = editor()
  view.pointer('key-0')
  view.button('复制').props.onClick(); view.render()
  view.find(node => node.props.className === 'timeline-seek')[0].props.onChange({ target: { value: '2' } }); view.render()
  const before = view.studio.archiveData()
  const history = view.studio.get().history.entries.length
  view.failNext()
  await view.button('粘贴').props.onClick()
  await view.flush()
  assert.deepEqual(view.selected(), ['key-0'])
  assert.deepEqual(view.studio.archiveData(), before)
  assert.equal(view.studio.get().history.entries.length, history)
  await view.button('粘贴').props.onClick()
  await view.flush()
  const pasted = view.studio.get().look2.animations[0].keyframeTracks[0].keyframes.find(key => key.time === 2)
  assert.deepEqual(view.selected(), [pasted.id])
  assert.equal(view.studio.get().history.entries.length, history + 1)
})

test('keyboard click selects once and a cancelled pointer drag cannot move a key', async () => {
  const view = editor()
  view.key('key-0').props.onClick({ detail: 0 }); view.render()
  view.key('key-1').props.onClick({ detail: 0, ctrlKey: true }); view.render()
  assert.deepEqual(view.selected().sort(), ['key-0', 'key-1'])
  const event = { button: 0, clientX: 100, pointerId: 1, stopPropagation() {}, currentTarget: { setPointerCapture() {} } }
  view.key('key-0').props.onPointerDown(event); view.render()
  view.key('key-0').props.onPointerCancel(); view.render()
  view.key('key-0').props.onPointerUp({ ...event, clientX: 180 })
  await view.flush()
  assert.deepEqual(view.studio.get().look2.animations[0].keyframeTracks.map(track => track.keyframes[0].time), [1, 1])
})

test('a cancelled canvas gesture cannot be committed by a later pointer release', async () => {
  const view = editor({ fields: [] })
  const selectedId = view.studio.get().selectedId
  const box = view.find(node => node.props.key === selectedId && /^look2-box /.test(node.props.className || ''))[0]
  const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }) }
  const event = { button: 0, clientX: 800, clientY: 450, pointerId: 1, stopPropagation() {},
    currentTarget: { closest: () => stage, setPointerCapture() {} } }
  box.props.onPointerDown(event)
  await view.flush()
  const before = view.studio.get().root
  const wrapper = view.find(node => node.props.className === 'look2-stage-wrap')[0]
  wrapper.props.onPointerCancel(event)
  wrapper.props.onPointerUp({ ...event, clientX: 920, clientY: 410 })
  await view.flush()
  assert.deepEqual(view.studio.get().root, before)
})

test('a keyframe numeric draft commits a negative decimal once and retains its captured target', async () => {
  const view = editor()
  view.pointer('key-0')
  const input = view.find(node => node.props.ariaLabel === '关键帧属性值')[0]
  assert.ok(input, 'numeric keyframe values must use a draft input')
  const draft = createInputDraft('20', { onDiscardError: input.props.onDiscardError })
  const history = view.studio.get().history.entries.length
  for (const value of ['-', '-1', '-12', '-12.', '-12.5']) draft.edit(value)
  assert.equal(view.studio.get().history.entries.length, history)
  view.delay()
  const pending = commitInputDraft(draft, value => input.props.onCommit(Number(value)))
  view.pointer('key-1')
  view.release()
  const result = await pending
  await view.flush()
  assert.equal(result.ok, true)
  assert.deepEqual(view.studio.get().look2.animations[0].keyframeTracks.map(track => track.keyframes[0].value), [-12.5, 128])
  assert.equal(view.studio.get().history.entries.length, history + 1)
})

test('a failed keyframe value draft keeps the committed value and Escape releases the action barrier', async () => {
  const view = editor()
  view.pointer('key-0')
  const input = view.find(node => node.props.ariaLabel === '关键帧属性值')[0]
  assert.ok(input)
  const draft = createInputDraft('20', { onDiscardError: input.props.onDiscardError })
  draft.edit('-12.5')
  const before = view.studio.archiveData()
  view.failNext()
  const result = await commitInputDraft(draft, value => input.props.onCommit(Number(value)))
  assert.equal(result.ok, false)
  assert.equal(draft.value, '-12.5')
  assert.deepEqual(view.studio.archiveData(), before)
  await assert.rejects(view.beforeAction(), /模拟提交失败/)
  draft.reset('20')
  await view.beforeAction()
  assert.deepEqual(view.studio.archiveData(), before)
})

test('queued keyframe RGB and alpha edits preserve both channels for right and incoming values', async () => {
  for (const incoming of [false, true]) {
    const view = editor({ fields: ['imageColor'], values: [{ r: 255, g: 100, b: 40, a: 1 }] })
    view.pointer('key-0')
    if (incoming) {
      view.button('添加入侧跳变值').props.onClick()
      await view.flush()
    }
    const label = incoming ? '入侧属性值' : '关键帧属性值'
    const rgb = view.find(node => node.props['aria-label'] === label && node.props.type === 'color')[0]
    const alpha = view.find(node => node.props.ariaLabel === `${label} Alpha`)[0]
    assert.ok(rgb)
    assert.ok(alpha, 'alpha values must use a draft input')
    view.delay()
    rgb.props.onChange({ target: { value: '#123456' } })
    const pending = alpha.props.onCommit(.25)
    await view.flush()
    view.release()
    await pending
    await view.flush()
    const key = view.studio.get().look2.animations[0].keyframeTracks[0].keyframes[0]
    assert.deepEqual(key[incoming ? 'leftValue' : 'value'], { r: 18, g: 52, b: 86, a: .25 })
    if (incoming) assert.deepEqual(key.value, { r: 255, g: 100, b: 40, a: 1 })
  }
})

test('adding an incoming jump uses the queued right value and a single undoable transaction', async () => {
  const view = editor()
  view.pointer('key-0')
  const historyBefore = view.studio.get().history.entries.length
  const input = view.find(node => node.props.ariaLabel === '关键帧属性值')[0]
  view.delay()
  const edit = input.props.onCommit(-12.5)
  const add = view.button('添加入侧跳变值').props.onClick()
  await view.flush()
  view.release()
  await Promise.all([edit, add])
  const readKey = () => view.studio.get().look2.animations[0].keyframeTracks[0].keyframes[0]
  assert.equal(readKey().leftValue, -12.5)
  assert.equal(readKey().leftRelative, false)
  assert.equal(view.studio.get().history.entries.length, historyBefore + 2)
  view.studio.history({ action: 'undo', expectedRevision: view.studio.get().version })
  assert.equal(readKey().value, -12.5)
  assert.equal(readKey().leftValue, undefined)
  assert.equal(readKey().leftRelative, undefined)
  view.studio.history({ action: 'redo', expectedRevision: view.studio.get().version })
  assert.equal(readKey().leftValue, -12.5)
  assert.equal(readKey().leftRelative, false)

  const failed = editor()
  failed.pointer('key-0')
  const before = failed.studio.archiveData()
  const failureHistory = failed.studio.get().history.entries.length
  failed.failNext()
  await assert.rejects(failed.button('添加入侧跳变值').props.onClick(), /模拟提交失败/)
  assert.deepEqual(failed.studio.archiveData(), before)
  assert.equal(failed.studio.get().history.entries.length, failureHistory)
})

test('queued runtime RGB and alpha edits merge the latest image and text color channels in both orders', async () => {
  for (const [selectedId, fieldKey, label] of [
    ['n3', 'imageColor', '填充色'], ['n2', 'fontColor', '文本色'],
    ['n2', 'bgColor', '背景色'], ['n2', 'outlineColor', '描边色'],
  ]) {
    for (const alphaFirst of [false, true]) {
      const view = editor({ selectedId, fields: [] })
      view.find(node => node.type === 'button' && node.children.includes('运行时'))[0].props.onClick()
      view.render()
      const expand = view.find(node => node.type === 'button' && node.children.includes('展开全部运行时字段'))[0]
      if (expand) { expand.props.onClick(); view.render() }
      const row = view.find(node => node.props.className === 'look2-field' && node.children.some(child => child.type === 'label' && child.children.includes(label)))[0]
      const rgb = row.children.find(node => node.props?.type === 'color')
      const alpha = row.children.find(node => node.props?.['aria-label'] === `${label} alpha`)
      const changeRgb = () => rgb.props.onChange({ target: { value: '#147ac4' } })
      const changeAlpha = () => alpha.props.onChange({ target: { value: '.23' } })
      const historyBefore = view.studio.get().history.entries.length
      view.delay()
      if (alphaFirst) { changeAlpha(); changeRgb() }
      else { changeRgb(); changeAlpha() }
      await view.flush()
      view.release()
      await view.beforeAction()
      const current = view.studio.get()
      assert.equal(current.inspector.fields.find(field => field.key === fieldKey).value >>> 0, 0x3b147ac4)
      assert.equal(view.studio.get().history.entries.length, historyBefore + 2)
    }
  }
})

test('keyframe time drafts read back frame snapping and invalid numeric values do not mutate history', async () => {
  const view = editor()
  view.pointer('key-0')
  const time = view.find(node => node.props.ariaLabel === '关键帧时间')[0]
  const value = view.find(node => node.props.ariaLabel === '关键帧属性值')[0]
  assert.ok(time)
  assert.ok(value)
  const saved = await time.props.onCommit(1.016)
  assert.equal(time.props.readCommitted(saved, 1.016), 1)
  const before = view.studio.archiveData()
  await assert.rejects(value.props.onCommit(NaN), /有限数字/)
  await assert.rejects(time.props.onCommit(Infinity), /有限数字/)
  assert.deepEqual(view.studio.archiveData(), before)
})

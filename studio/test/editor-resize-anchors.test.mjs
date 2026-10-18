import test from 'node:test'
import assert from 'node:assert/strict'
import { createAnimationView } from '../../editor-ui/look2.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject } from '../ui/authoring.js'
import { applyMatrix } from '../ui/layout.js'
import { previewAnimation } from '../look2/preview.js'

function findNode(root, id) {
  if (root?.id === id) return root
  for (const child of root?.children || []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return null
}

function makeView(studio) {
  const initial = studio.get()
  const slots = []
  let cursor = 0
  let tree
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
    useCallback: callback => callback,
  }
  const { AnimationView } = createAnimationView(React, {
    WorkspaceInspector() {},
    api: async (_session, action, body) => {
      if (action === 'template') return studio.template(body)
      assert.equal(action, 'transaction')
      return studio.transaction(body)
    },
  })
  function render() { cursor = 0; tree = AnimationView({ sessionId: 'resize-anchor-regression' }); return tree }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap(child => find(predicate, child))]
  }
  render()
  return { render, find }
}

function currentPreview(studio, id) {
  const snap = studio.get()
  const animation = snap.look2.animations.find(row => row.id === snap.look2.activeAnimationId) || { keyframeTracks: [] }
  return previewAnimation(snap.animationPreviewRoot, animation, 0, snap.canvas).find(row => row.id === id)
}

function pointOn(row, u, v) {
  return applyMatrix(row.matrix, row.left + row.width * u, row.bottom + row.height * v)
}

const handles = [
  { name: 'east', handle: 'e', u: 1, v: .5, fixedU: 0, fixedV: .5, dx: 40, dy: 0, width: 40, height: 0 },
  { name: 'west', handle: 'w', u: 0, v: .5, fixedU: 1, fixedV: .5, dx: -40, dy: 0, width: 40, height: 0 },
  { name: 'north', handle: 'n', u: .5, v: 1, fixedU: .5, fixedV: 0, dx: 0, dy: 30, width: 0, height: 30 },
  { name: 'south', handle: 's', u: .5, v: 0, fixedU: .5, fixedV: 1, dx: 0, dy: -30, width: 0, height: 30 },
  { name: 'north-east', handle: 'ne', u: 1, v: 1, fixedU: 0, fixedV: 0, dx: 40, dy: 30, width: 40, height: 30 },
  { name: 'north-west', handle: 'nw', u: 0, v: 1, fixedU: 1, fixedV: 0, dx: -40, dy: 30, width: 40, height: 30 },
  { name: 'south-east', handle: 'se', u: 1, v: 0, fixedU: 0, fixedV: 1, dx: 40, dy: -30, width: 40, height: 30 },
  { name: 'south-west', handle: 'sw', u: 0, v: 0, fixedU: 1, fixedV: 1, dx: -40, dy: -30, width: 40, height: 30 },
]

async function resize({ handleCase, transformConfig, parentConfig, childStretch, clampWidth } = {}) {
  const studio = createStudio(createDefaultClientTemplateProject())
  const platform = studio.get().canvas.platform
  const id = childStretch ? 'n2' : studio.get().selectedId
  if (parentConfig) {
    const parent = findNode(studio.get().root, 'n1')
    const transform = structuredClone(parent.transformByPlatform[platform])
    transform.rotation.z = parentConfig.rotationZ
    transform.scale.x = parentConfig.scaleX
    transform.scale.y = parentConfig.scaleY
    studio.patch({ op: 'setPlatformTransform', id: 'n1', platform, transform })
  }
  if (transformConfig || childStretch) {
    const node = findNode(studio.get().root, id)
    const transform = structuredClone(node.transformByPlatform[platform])
    if (transformConfig) {
      transform.rotation.z = transformConfig.rotationZ
      transform.scale.x = transformConfig.scaleX
      transform.scale.y = transformConfig.scaleY
      transform.pivot.x = transformConfig.pivotX
      transform.pivot.y = transformConfig.pivotY
    }
    if (childStretch) {
      transform.anchorMin.x = .1
      transform.anchorMax.x = .9
      transform.size.x = 0
      transform.pivot.x = .23
      transform.pivot.y = .68
    }
    studio.patch({ op: 'setPlatformTransform', id, platform, transform })
  }
  if (studio.get().selectedId !== id) studio.patch({ op: 'select', id })

  const view = makeView(studio)
  const beforeSnap = studio.get()
  const beforeNode = findNode(beforeSnap.root, id)
  const transformBefore = structuredClone(beforeNode.transformByPlatform[platform])
  const initialHistory = beforeSnap.history.entries.length
  const before = currentPreview(studio, id)
  assert.ok(before?.matrix, `${handleCase?.name || 'clamp'}: selected preview needs a matrix`)
  const start = pointOn(before, handleCase?.u ?? (clampWidth ? 0 : 1), handleCase?.v ?? .5)
  let dx = handleCase?.dx ?? -before.width
  let dy = handleCase?.dy ?? 0
  if (clampWidth) dx = before.width + 20
  const expectedWidth = clampWidth ? 1 : Math.max(1, before.width + (handleCase?.width ?? -dx))
  const expectedHeight = Math.max(1, before.height + (handleCase?.height ?? dy))
  const end = applyMatrix(before.matrix,
    before.left + before.width * (handleCase?.u ?? 1) + dx,
    before.bottom + before.height * (handleCase?.v ?? .5) + dy)
  const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: beforeSnap.canvas.width, height: beforeSnap.canvas.height }) }
  const eventAt = point => ({ button: 0, pointerId: 7, clientX: point.x, clientY: beforeSnap.canvas.height - point.y,
    stopPropagation() {}, currentTarget: { closest: () => stage, setPointerCapture() {} } })
  const handleName = handleCase?.handle || 'w'
  const handle = view.find(row => row.props.className === `look2-handle ${handleName}`)[0]
  assert.ok(handle, `${handleName} resize handle must render`)
  handle.props.onPointerDown(eventAt(start))
  await new Promise(resolve => setImmediate(resolve))
  view.render()
  const resizeHistoryStart = studio.get().history.entries.length
  const activeHandle = view.find(row => row.props.className === `look2-handle ${handleName}`)[0]
  activeHandle.props.onPointerUp(eventAt(end))
  await new Promise(resolve => setImmediate(resolve))
  view.render()

  const after = currentPreview(studio, id)
  const fixedBefore = pointOn(before, handleCase?.fixedU ?? 1, handleCase?.fixedV ?? .5)
  const fixedAfter = pointOn(after, handleCase?.fixedU ?? 1, handleCase?.fixedV ?? .5)
  const draggedAfter = pointOn(after, handleCase?.u ?? (clampWidth ? 0 : 1), handleCase?.v ?? .5)
  const fixedDrift = Math.hypot(fixedAfter.x - fixedBefore.x, fixedAfter.y - fixedBefore.y)
  const expectedDragged = clampWidth ? null : applyMatrix(before.matrix,
    before.left + before.width * (handleCase?.u ?? 1) + dx,
    before.bottom + before.height * (handleCase?.v ?? .5) + dy)
  const draggedDrift = expectedDragged ? Math.hypot(draggedAfter.x - expectedDragged.x, draggedAfter.y - expectedDragged.y) : null
  const changedTransform = structuredClone(findNode(studio.get().root, id).transformByPlatform[platform])
  const historyAfter = studio.get().history.entries.length
  const result = { id, platform, widthBefore: before.width, widthAfter: after.width, heightBefore: before.height,
    heightAfter: after.height, fixedBefore, fixedAfter, fixedDrift, draggedAfter, expectedDragged, draggedDrift,
    historyDelta: historyAfter - resizeHistoryStart, initialHistory, transformBefore, changedTransform }

  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  const undoTransform = structuredClone(findNode(studio.get().root, id).transformByPlatform[platform])
  studio.history({ action: 'redo', expectedRevision: studio.get().version })
  const redoTransform = structuredClone(findNode(studio.get().root, id).transformByPlatform[platform])
  result.undoTransform = undoTransform
  result.redoTransform = redoTransform
  result.historyDelta = studio.get().history.entries.length - resizeHistoryStart
  return { result, expectedWidth, expectedHeight }
}

for (const handleCase of handles) {
  test(`stage ${handleCase.name} resize keeps the opposite edge or corner fixed and follows the pointer`, async () => {
    const { result, expectedWidth, expectedHeight } = await resize({ handleCase })
    assert.ok(result.fixedDrift < 1e-6, `${handleCase.name}: fixed point drifted ${result.fixedDrift}: ${JSON.stringify(result)}`)
    assert.ok(result.draggedDrift < 1e-6, `${handleCase.name}: dragged point missed by ${result.draggedDrift}: ${JSON.stringify(result)}`)
    assert.ok(Math.abs(result.widthAfter - expectedWidth) < 1e-6)
    assert.ok(Math.abs(result.heightAfter - expectedHeight) < 1e-6)
    assert.equal(result.historyDelta, 1, 'resize must be one undoable transaction')
    assert.deepEqual(result.undoTransform, result.transformBefore)
    assert.deepEqual(result.redoTransform, result.changedTransform)
  })
}

for (const config of [
  { name: 'rotation', rotationZ: 35, scaleX: 1, scaleY: 1, pivotX: .5, pivotY: .5 },
  { name: 'scale', rotationZ: 0, scaleX: 1.4, scaleY: .75, pivotX: .5, pivotY: .5 },
  { name: 'rotation-scale-offset-pivot', rotationZ: 35, scaleX: 1.4, scaleY: .75, pivotX: .2, pivotY: .7 },
]) {
  test(`stage east resize preserves opposite edge with own ${config.name}`, async () => {
    const { result } = await resize({ handleCase: handles[0], transformConfig: config })
    assert.ok(result.fixedDrift < 1e-6, `${config.name}: fixed point drifted ${result.fixedDrift}: ${JSON.stringify(result)}`)
    assert.ok(result.draggedDrift < 1e-6, `${config.name}: dragged point missed by ${result.draggedDrift}: ${JSON.stringify(result)}`)
    assert.equal(result.historyDelta, 1)
    assert.deepEqual(result.undoTransform, result.transformBefore)
    assert.deepEqual(result.redoTransform, result.changedTransform)
  })
}

test('stage west resize clamps width to one while preserving its opposite edge', async () => {
  const { result, expectedWidth } = await resize({ handleCase: handles[1], clampWidth: true })
  assert.equal(expectedWidth, 1)
  assert.ok(Math.abs(result.widthAfter - 1) < 1e-6)
  assert.ok(result.fixedDrift < 1e-6, `clamped fixed point drifted ${result.fixedDrift}: ${JSON.stringify(result)}`)
  assert.equal(result.historyDelta, 1)
  assert.deepEqual(result.undoTransform, result.transformBefore)
  assert.deepEqual(result.redoTransform, result.changedTransform)
})

test('stage east resize preserves stretched child edge under rotated scaled parent', async () => {
  const { result } = await resize({ handleCase: handles[0], parentConfig: { rotationZ: 31, scaleX: 1.3, scaleY: .8 }, childStretch: true })
  assert.ok(result.fixedDrift < 1e-6, `parent transform and stretched anchors moved fixed edge by ${result.fixedDrift}: ${JSON.stringify(result)}`)
  assert.ok(result.draggedDrift < 1e-6, `parent transform and stretched anchors missed dragged edge by ${result.draggedDrift}: ${JSON.stringify(result)}`)
  assert.equal(result.historyDelta, 1)
  assert.deepEqual(result.undoTransform, result.transformBefore)
  assert.deepEqual(result.redoTransform, result.changedTransform)
})

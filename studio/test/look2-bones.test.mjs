import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio } from '../index.js'
import { CANONICAL_CANVAS_BY_PLATFORM, CANVAS_PRESETS, PLATFORMS } from '../constants.js'
import { createDefaultClientTemplateProject, findNode, findParent, walk } from '../ui/authoring.js'
import { layoutTree } from '../ui/inspector.js'
import { applyMatrix } from '../ui/layout.js'
import { exportSiteJson, importSiteJson } from '../look2/site-json.js'
import { previewAnimation } from '../look2/preview.js'
import { sampleTrack } from '../look2/sampling.js'
import { isValidAssetIndex } from '../gia/asset-indices.js'
import {
  buildBoneAttachmentPlan, buildBoneTransformMap, preserveAttachmentAnimationState,
  preserveUntrackedAttachmentPose, updateBoneDirectionState,
} from '../look2/bones.js'

const currentCanvas = CANVAS_PRESETS['pc-16-9']
const endpoints = { start: { x: 720, y: 440 }, end: { x: 900, y: 505 } }

function newStudio() { return createStudio(createDefaultClientTemplateProject()) }

function createBone(studio, id = 'bone-test-node') {
  const before = studio.get()
  const geometry = buildBoneTransformMap(before.root, {
    parentId: 'n1', ...endpoints, currentCanvas, currentPlatform: 'KEYBOARD',
  })
  return studio.transaction({ expectedRevision: before.version, label: '创建骨骼',
    ops: [{ op: 'add', id, kind: 'container', parentId: 'n1', name: '测试骨骼',
      transformByPlatform: geometry.transformByPlatform, syncAllDevices: false }],
    state: updateBoneDirectionState(before.look2, id, geometry.directionArrowLength, 'n1'),
  })
}

function close(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) < 1e-5, `${message}: expected ${expected}, got ${actual}`)
}

function transformedCorners(box) {
  return [
    [box.left, box.bottom], [box.right, box.bottom],
    [box.right, box.top], [box.left, box.top],
  ].map(([x, y]) => applyMatrix(box.renderMatrix, x, y))
}

function previewCorners(box) {
  return [
    [box.left, box.bottom], [box.right, box.bottom],
    [box.right, box.top], [box.left, box.top],
  ].map(([x, y]) => applyMatrix(box.matrix, x, y))
}

function assertSameWorldAppearance(beforeRoot, afterRoot, id, platform) {
  const canvas = CANVAS_PRESETS[CANONICAL_CANVAS_BY_PLATFORM[platform]]
  const beforeBox = layoutTree(beforeRoot, canvas, platform).boxes[id]
  const afterBox = layoutTree(afterRoot, canvas, platform).boxes[id]
  const expected = transformedCorners(beforeBox), actual = transformedCorners(afterBox)
  for (let index = 0; index < expected.length; index++) {
    close(actual[index].x, expected[index].x, `${id}/${platform}/corner${index}.x`)
    close(actual[index].y, expected[index].y, `${id}/${platform}/corner${index}.y`)
  }
}

test('bone creation prepares complete four-platform transforms with local direction length', () => {
  const project = createDefaultClientTemplateProject()
  const result = buildBoneTransformMap(project.root, {
    parentId: 'n1', ...endpoints, currentCanvas, currentPlatform: 'KEYBOARD',
  })
  assert.deepEqual(Object.keys(result.transformByPlatform).sort(), [...PLATFORMS].sort())
  assert.ok(result.directionArrowLength > 1)
  for (const platform of PLATFORMS) {
    const transform = result.transformByPlatform[platform]
    assert.deepEqual(transform.pivot, { x: 0, y: 0.5 })
    assert.ok(transform.size.x > 1 && transform.size.y > 0)
    assert.ok(Object.values(transform).flatMap(value => Object.values(value || {})).every(value => Number.isFinite(value)))
  }
})

test('one add transaction persists bone metadata and creates unique GUID and asset index; undo and redo restore both', () => {
  const studio = newStudio()
  const initial = studio.get()
  const initialIndices = new Set()
  walk(initial.root, item => { if (item.giaInfoIndex) initialIndices.add(item.giaInfoIndex) })
  const created = createBone(studio)
  const node = findNode(studio.archiveData().assets.client.root, 'bone-test-node')
  assert.equal(created.version, initial.version + 1)
  assert.equal(node.kind, 'container')
  assert.equal(node.syncAllDevices, false)
  assert.ok(node.guid > 0)
  assert.ok(isValidAssetIndex(node.giaInfoIndex))
  assert.equal(node.giaInfoIndexSource, 'authoring')
  assert.equal(initialIndices.has(node.giaInfoIndex), false)
  const guids = new Set()
  walk(studio.archiveData().assets.client.root, item => {
    if (item.guid) { assert.equal(guids.has(item.guid), false); guids.add(item.guid) }
  })
  walk(studio.archiveData().assets.client.root, item => {
    if (item.id !== node.id && item.giaInfoIndex === node.giaInfoIndex) assert.fail('新骨骼资产编号与现有节点重复')
  })
  const snapshot = studio.get()
  const json = exportSiteJson(studio.archiveData().assets.client, snapshot.look2)
  const exported = json.nodes.find(item => item.id === 'bone-test-node')
  assert.equal(exported.editor.directionArrowLength, snapshot.look2.siteNodes['bone-test-node'].editor.directionArrowLength)
  const roundtrip = importSiteJson(json)
  assert.equal(roundtrip.look2.siteNodes['bone-test-node'].editor.directionArrowLength, exported.editor.directionArrowLength)

  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  assert.equal(findNode(studio.archiveData().assets.client.root, 'bone-test-node'), null)
  assert.equal(studio.get().look2.siteNodes['bone-test-node'], undefined)
  studio.history({ action: 'redo', expectedRevision: studio.get().version })
  assert.ok(findNode(studio.archiveData().assets.client.root, 'bone-test-node'))
  assert.ok(studio.get().look2.siteNodes['bone-test-node'].editor.directionArrowLength > 1)
})

test('attachment preserves the control world matrix on all four platforms and is one undoable edit', () => {
  const studio = newStudio()
  createBone(studio)
  const before = studio.archiveData().assets.client
  const snapshot = studio.get()
  const plan = buildBoneAttachmentPlan(snapshot.root, 'n2', 'bone-test-node', {
    currentCanvas, currentPlatform: 'KEYBOARD', lockedIds: [],
  })
  const version = snapshot.version
  const result = studio.transaction({ expectedRevision: snapshot.version, label: '附着控件到骨骼', ops: [
    { op: 'reparent', id: 'n2', parentId: 'bone-test-node' },
    ...Object.entries(plan.transforms).map(([platform, transform]) => ({ op: 'setPlatformTransform', id: 'n2', platform, transform })),
    { op: 'set', id: 'n2', key: 'syncAllDevices', value: false },
  ] })
  const after = studio.archiveData().assets.client
  assert.equal(findNode(after.root, 'n2').syncAllDevices, false)
  assert.equal(result.version, version + 1)
  for (const platform of PLATFORMS) assertSameWorldAppearance(before.root, after.root, 'n2', platform)

  studio.history({ action: 'undo', expectedRevision: studio.get().version })
  assert.equal(findParent(studio.archiveData().assets.client.root, 'n2').id, 'n1')
  for (const platform of PLATFORMS) assertSameWorldAppearance(before.root, studio.archiveData().assets.client.root, 'n2', platform)
})

test('locked nodes and unrepresentable shear fail before mutation', () => {
  const studio = newStudio()
  createBone(studio)
  let snapshot = studio.get()
  const before = studio.archiveData()
  assert.throws(() => buildBoneAttachmentPlan(snapshot.root, 'n2', 'bone-test-node', {
    currentCanvas, currentPlatform: 'KEYBOARD', lockedIds: ['n2'],
  }), /锁定/)
  assert.throws(() => buildBoneAttachmentPlan(snapshot.root, 'n2', 'bone-test-node', {
    currentCanvas, currentPlatform: 'KEYBOARD', lockedIds: ['bone-test-node'],
  }), /锁定/)
  assert.deepEqual(studio.archiveData(), before)

  const parent = findNode(snapshot.root, 'bone-test-node')
  const tilted = structuredClone(parent.transformByPlatform.KEYBOARD)
  tilted.scale = { x: 2, y: 1, z: 1 }; tilted.rotation.z = 45
  studio.transaction({ expectedRevision: snapshot.version, ops: [{ op: 'setPlatformTransform', id: parent.id, platform: 'KEYBOARD', transform: tilted }] })
  snapshot = studio.get()
  const afterTilt = studio.archiveData()
  assert.throws(() => buildBoneAttachmentPlan(snapshot.root, 'n2', 'bone-test-node', {
    currentCanvas, currentPlatform: 'KEYBOARD',
  }), /剪切或退化缩放/)
  assert.deepEqual(studio.archiveData(), afterTilt)
})

test('attachment rebases the visible pose at the current animation frame with no or partial child tracks', () => {
  for (const hasPartialChildTrack of [false, true]) {
    const studio = newStudio()
    createBone(studio)
    let snapshot = studio.get()
    const state = structuredClone(snapshot.look2)
    const animation = state.animations.find(item => item.id === state.activeAnimationId)
    const baseAngle = findNode(snapshot.root, 'bone-test-node').transformByPlatform.KEYBOARD.rotation.z
    animation.keyframeTracks.push({ id: 'bone-turn', nodeId: 'bone-test-node', fieldKey: 'localRotationZ', keyframes: [
      { id: 'bone-turn-start', time: 0, value: baseAngle, relative: false, easeType: 'Linear', interpolation: 'tween' },
      { id: 'bone-turn-end', time: 1, value: baseAngle + 60, relative: false, easeType: 'Linear', interpolation: 'tween' },
    ] })
    if (hasPartialChildTrack) animation.keyframeTracks.push({ id: 'child-turn', nodeId: 'n2', fieldKey: 'localRotationZ', keyframes: [
      { id: 'child-turn-start', time: 0, value: 0, relative: false, easeType: 'Linear', interpolation: 'tween' },
      { id: 'child-turn-end', time: 1, value: 0, relative: false, easeType: 'Linear', interpolation: 'tween' },
    ] })
    studio.transaction({ expectedRevision: snapshot.version, state })
    snapshot = studio.get()
    const active = snapshot.look2.animations.find(item => item.id === snapshot.look2.activeAnimationId)
    const time = 0.5
    const beforeBoxes = previewAnimation(snapshot.animationPreviewRoot, active, time, currentCanvas)
    const beforeCorners = previewCorners(beforeBoxes.find(box => box.id === 'n2'))
    const plan = buildBoneAttachmentPlan(snapshot.root, 'n2', 'bone-test-node', {
      currentCanvas, currentPlatform: currentCanvas.platform, previewBoxes: beforeBoxes,
    })
    let generatedId = 0
    const rebased = preserveAttachmentAnimationState(snapshot.look2, 'n2', active.id, plan.previewTransform,
      time, kind => `attach-${hasPartialChildTrack ? 'partial' : 'empty'}-${kind}-${generatedId++}`)
    const childTracks = rebased?.animations.find(item => item.id === active.id).keyframeTracks.filter(track => track.nodeId === 'n2')
      || animation.keyframeTracks.filter(track => track.nodeId === 'n2')
    const transforms = { ...plan.transforms }
    transforms[currentCanvas.platform] = preserveUntrackedAttachmentPose(transforms[currentCanvas.platform], snapshot.look2,
      'n2', active.id, plan.previewTransform)
    if (hasPartialChildTrack) {
      assert.deepEqual(childTracks.map(track => track.fieldKey), ['localRotationZ'])
      assert.deepEqual(childTracks[0].keyframes.map(key => key.time), [0, 0.5, 1])
      assert.equal(childTracks[0].keyframes[1].value, plan.previewTransform.rotation.z)
    } else {
      assert.equal(rebased, null)
      assert.equal(childTracks.length, 0)
      assert.equal(transforms[currentCanvas.platform].offset.x, plan.previewTransform.offset.x)
    }
    const result = studio.transaction({ expectedRevision: snapshot.version, ops: [
      { op: 'reparent', id: 'n2', parentId: 'bone-test-node' },
      ...Object.entries(transforms).map(([platform, transform]) => ({ op: 'setPlatformTransform', id: 'n2', platform, transform })),
      { op: 'set', id: 'n2', key: 'syncAllDevices', value: false },
    ], ...(rebased ? { state: rebased } : {}) })
    const afterBoxes = previewAnimation(result.animationPreviewRoot,
      result.look2.animations.find(item => item.id === result.look2.activeAnimationId), time, currentCanvas)
    const afterCorners = previewCorners(afterBoxes.find(box => box.id === 'n2'))
    for (let index = 0; index < beforeCorners.length; index++) {
      close(afterCorners[index].x, beforeCorners[index].x, `partial=${hasPartialChildTrack}/corner${index}.x`)
      close(afterCorners[index].y, beforeCorners[index].y, `partial=${hasPartialChildTrack}/corner${index}.y`)
    }
  }
})

test('explicit add ids reject duplicates atomically', () => {
  const studio = newStudio()
  createBone(studio)
  const before = studio.archiveData()
  const current = studio.get()
  assert.throws(() => studio.transaction({ expectedRevision: current.version,
    ops: [{ op: 'add', id: 'bone-test-node', kind: 'container', parentId: 'n1', name: '重复骨骼' }] }), /duplicate node id/)
  assert.deepEqual(studio.archiveData(), before)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { preparePlatformTransformEdit } from '../../editor-ui/platform-transform-edit.js'
import { createStudio } from '../index.js'
import { createDefaultClientTemplateProject, findNode } from '../ui/authoring.js'

function commitPrepared(studio, current, prepared, label) {
  if (prepared.skip) return current
  return studio.transaction({
    expectedRevision: current.version,
    label,
    ops: prepared.ops,
    state: prepared.state,
  })
}

test('queued platform axis edits merge against the latest transform', () => {
  const studio = createStudio(createDefaultClientTemplateProject())
  let current = studio.get()
  const id = current.selectedId
  const platform = current.canvas.platform
  const makeId = (() => { let serial = 0; return () => `axis-key-${++serial}` })()

  current = commitPrepared(studio, current, preparePlatformTransformEdit(current, {
    id, platform, section: 'offset', axis: 'x', value: 111, makeId,
  }), 'A 轴')
  current = commitPrepared(studio, current, preparePlatformTransformEdit(current, {
    id, platform, section: 'offset', axis: 'y', value: 222, makeId,
  }), 'B 轴')

  const transform = findNode(current.root, id).transformByPlatform[platform]
  assert.equal(transform.offset.x, 111)
  assert.equal(transform.offset.y, 222)
})

test('a later axis recording keeps earlier queued axis keyframes', () => {
  const studio = createStudio(createDefaultClientTemplateProject())
  let current = studio.get()
  const id = current.selectedId
  const state = structuredClone(current.look2)
  const animation = state.animations.find(item => item.id === state.activeAnimationId)
  animation.keyframeTracks = [
    { id: 'axis-track-x', nodeId: id, fieldKey: 'anchoredPositionX', keyframes: [] },
    { id: 'axis-track-y', nodeId: id, fieldKey: 'anchoredPositionY', keyframes: [] },
  ]
  current = studio.setLook2(state, current.version)
  const platform = current.canvas.platform
  const makeId = (() => { let serial = 0; return () => `record-key-${++serial}` })()

  current = commitPrepared(studio, current, preparePlatformTransformEdit(current, {
    id, platform, section: 'offset', axis: 'x', value: 333, playhead: .5, makeId,
  }), '录制 X')
  current = commitPrepared(studio, current, preparePlatformTransformEdit(current, {
    id, platform, section: 'offset', axis: 'y', value: 444, playhead: .5, makeId,
  }), '录制 Y')

  const updated = current.look2.animations.find(item => item.id === animation.id)
  const xFrame = updated.keyframeTracks.find(track => track.fieldKey === 'anchoredPositionX').keyframes[0]
  const yFrame = updated.keyframeTracks.find(track => track.fieldKey === 'anchoredPositionY').keyframes[0]
  assert.equal(xFrame.value, 333)
  assert.equal(yFrame.value, 444)
  assert.equal(xFrame.time, yFrame.time)
})

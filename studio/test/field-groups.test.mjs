import test from 'node:test'
import assert from 'node:assert/strict'
import { computeRect } from '../ui/layout.js'
import { inspectorTransformChannels, setAbsoluteKeyframeValue } from '../../editor-ui/field-groups.js'

test('Inspector width changes map to sizeDelta after stretch-anchor geometry is resolved', () => {
  const parent = { left: 0, bottom: 0, width: 400, height: 300 }
  const source = {
    scale: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 },
    anchorMin: { x: 0.2, y: 0.25 }, anchorMax: { x: 0.8, y: 0.75 },
    offset: { x: 12, y: -8 }, size: { x: 90, y: 60 }, pivot: { x: 0.25, y: 0.7 },
  }
  const box = computeRect(parent, source)
  const result = inspectorTransformChannels(source, parent, box, { width: 140 })

  assert.ok(Math.abs(result.transform.size.x - (140 - (0.8 - 0.2) * 400)) < 1e-9)
  assert.equal(result.transform.offset.x, box.centerX - 140 / 2 - parent.left - 0.2 * parent.width + result.transform.size.x * 0.25)
  assert.equal(result.transform.size.y, source.size.y)
  assert.equal(result.channels.sizeDeltaX, result.transform.size.x)
  assert.equal(result.channels.anchoredPositionX, result.transform.offset.x)
  assert.equal(result.channels.sizeDeltaY, undefined)
})

test('Inspector position and rotation map to local animation channels', () => {
  const parent = { left: 0, bottom: 0, width: 320, height: 180 }
  const source = {
    scale: { x: 1, y: 1, z: 1 }, rotation: { x: 2, y: 3, z: 4 },
    anchorMin: { x: 0.5, y: 0.5 }, anchorMax: { x: 0.5, y: 0.5 },
    offset: { x: 0, y: 0 }, size: { x: 100, y: 50 }, pivot: { x: 0.5, y: 0.5 },
  }
  const box = computeRect(parent, source)
  const result = inspectorTransformChannels(source, parent, box, { posX: 200, rotationZ: 35 })

  assert.equal(result.channels.anchoredPositionX, 40)
  assert.equal(result.channels.localRotationZ, 35)
  assert.deepEqual(result.channels, { anchoredPositionX: 40, localRotationZ: 35 })
})

test('writing a resolved keyframe value clears legacy delta semantics', () => {
  const key = { time: 2, value: 6, relative: true, isDelta: true, _legacyBaseDelta: true, leftValue: 3 }
  setAbsoluteKeyframeValue(key, 20)

  assert.equal(key.value, 20)
  assert.equal(key.relative, false)
  assert.equal(Object.hasOwn(key, 'isDelta'), false)
  assert.equal(Object.hasOwn(key, '_legacyBaseDelta'), false)
  assert.equal(key.leftValue, 3)
})

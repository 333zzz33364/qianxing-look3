import test from 'node:test'
import assert from 'node:assert/strict'
import { EASE_TYPES } from '../look2/sampling.js'
import { EASE_TYPE_LABELS, easeTypeLabel } from '../../editor-ui/ease-labels.js'

test('every ease enum has a Chinese label and no extra keys', () => {
  for (const type of EASE_TYPES) {
    const label = EASE_TYPE_LABELS[type]
    assert.ok(label, `${type} 缺少中文名`)
    assert.match(label, /[\u4e00-\u9fff]/u, `${type} 的中文名应包含汉字`)
  }
  assert.equal(Object.keys(EASE_TYPE_LABELS).length, EASE_TYPES.length, '中文名数量应与枚举一致')
})

test('unknown or empty ease values fall back to the raw text', () => {
  assert.equal(easeTypeLabel('Linear'), '线性')
  assert.equal(easeTypeLabel('InOutQuad'), '二次缓入缓出')
  assert.equal(easeTypeLabel('FutureEase'), 'FutureEase')
  assert.equal(easeTypeLabel(undefined), '')
})

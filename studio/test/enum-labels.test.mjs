import test from 'node:test'
import assert from 'node:assert/strict'
import { SIGNAL_PARAM_TYPES } from '../../editor-ui/signal-params.js'
import { SIGNAL_PARAM_TYPE_LABELS, entityLabel, hasChineseSignalParamLabel, signalParamTypeLabel } from '../../editor-ui/enum-labels.js'

test('every signal parameter type shows a Chinese label with the enum kept', () => {
  for (const type of SIGNAL_PARAM_TYPES) {
    assert.ok(hasChineseSignalParamLabel(type), `${type} 缺少中文名`)
    const label = signalParamTypeLabel(type)
    assert.match(label, /[\u4e00-\u9fff]/u, `${type} 的显示名应含中文`)
    assert.ok(label.includes(type), `${type} 的显示名应保留枚举值以便对照`)
  }
  assert.equal(Object.keys(SIGNAL_PARAM_TYPE_LABELS).length, SIGNAL_PARAM_TYPES.length)
  assert.equal(signalParamTypeLabel('Guid'), 'Guid')
})

test('entity options read Chinese first and keep the raw identifier', () => {
  assert.equal(entityLabel('PlayerSelf'), '当前玩家（PlayerSelf）')
  assert.equal(entityLabel('Level'), '关卡（Level）')
  assert.equal(entityLabel('AllPlayers'), '所有玩家（AllPlayers）')
  assert.equal(entityLabel('AvatarSelf'), '当前角色（AvatarSelf）')
  assert.equal(entityLabel('Player3'), '玩家3（Player3）')
  assert.equal(entityLabel('Avatar2'), '角色2（Avatar2）')
  assert.equal(entityLabel('SomethingElse'), 'SomethingElse')
  assert.equal(entityLabel(''), '')
})

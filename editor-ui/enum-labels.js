// 界面枚举的中文显示。值仍用英文标识，括号里保留原值方便对照文档与存档。
import { SIGNAL_PARAM_TYPES } from './signal-params.js'

export const SIGNAL_PARAM_TYPE_LABELS = Object.freeze({
  Int: '整数',
  Float: '小数',
  String: '字符串',
  Bool: '布尔',
  IntList: '整数列表',
  FloatList: '小数列表',
  StringList: '字符串列表',
  BoolList: '布尔列表',
  Vector3: '三维向量',
})

export function signalParamTypeLabel(type) {
  const label = SIGNAL_PARAM_TYPE_LABELS[type]
  return label ? `${label}（${type}）` : String(type ?? '')
}

const ENTITY_LABELS = Object.freeze({
  PlayerSelf: '当前玩家',
  Level: '关卡',
  AvatarSelf: '当前角色',
  AllPlayers: '所有玩家',
})

export function entityLabel(value) {
  const text = String(value ?? '')
  const fixed = ENTITY_LABELS[text]
  if (fixed) return `${fixed}（${text}）`
  const player = /^Player([1-9])$/u.exec(text)
  if (player) return `玩家${player[1]}（${text}）`
  const avatar = /^Avatar([1-9])$/u.exec(text)
  if (avatar) return `角色${avatar[1]}（${text}）`
  return text
}

// 供测试与界面共用：确认每个参数类型都有中文名。
export function hasChineseSignalParamLabel(type) {
  return Boolean(SIGNAL_PARAM_TYPE_LABELS[type]) && SIGNAL_PARAM_TYPES.includes(type)
}

import { buildEnumTree } from 'qxqy-lua-runtime'

// The runtime owns the public names. Native encodings are only the ranges
// verified by the fixed UI editor; ordinal positions are not wire values.
const enums = buildEnumTree()
export const keyCodeNames = type => Object.keys(enums[type] || {})
const controllerNames = keyCodeNames('ControllerKeyCode').filter(name => name !== 'None')

export function normalizeKeyCode(value, type) {
  if (value == null) return null
  if (typeof value === 'string') {
    if (value === 'None') return 0
    if (keyCodeNames(type).includes(value)) {
      if (type === 'ControllerKeyCode') return controllerNames.indexOf(value) + 1
      const craftsperson = /^CraftspersonKey(\d+)$/.exec(value)
      return craftsperson ? Number(craftsperson[1]) : value
    }
    if (/^\d+$/.test(value)) value = Number(value)
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) throw new Error('按键必须为已知枚举名称或非负整数')
  return value
}

export function keyCodeOptions(type, current) {
  const options = [{ value: null, label: '未设置' }, ...keyCodeNames(type).map(name => ({ value: normalizeKeyCode(name, type), label: name }))]
  if (current != null && !options.some(option => option.value === current)) options.push({ value: current, label: `原始按键编号 ${current}` })
  return options
}

export function assertNativeKeyCode(value, type) {
  const normalized = normalizeKeyCode(value, type)
  if (typeof normalized === 'string') throw new Error(`尚未核实键盘按键 ${normalized} 的 GIA 编码；已保留 JSON/Lua 枚举，请勿推断原生编号`)
  return normalized
}

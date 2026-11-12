// 「发送服务端信号」的参数行。每行是 { type, value }，value 在界面上是字符串
// 或布尔；发送前统一校验成服务端的 typedParams 形状 [{ type, value }]。
// 注意：类型只影响服务端出站日志与录像回放，客户端 Lua 收到的仍是值本身。

export const SIGNAL_PARAM_TYPES = Object.freeze([
  'Int', 'Float', 'String', 'Bool',
  'IntList', 'FloatList', 'StringList', 'BoolList',
  'Vector3',
])

const DEFAULT_VALUES = Object.freeze({
  Int: '0',
  Float: '0',
  String: '',
  Bool: true,
  IntList: '[]',
  FloatList: '[]',
  StringList: '[]',
  BoolList: '[]',
  Vector3: '{"x":0,"y":0,"z":0}',
})

export function createSignalParam(type = 'Int') {
  if (!SIGNAL_PARAM_TYPES.includes(type)) throw new Error(`未知参数类型：${type}`)
  return { type, value: DEFAULT_VALUES[type] }
}

export function signalParamHint(type) {
  switch (type) {
    case 'Int': return '整数，如 1'
    case 'Float': return '数字，如 1.5'
    case 'String': return '文本'
    case 'Bool': return '布尔'
    case 'Vector3': return '{"x":0,"y":0,"z":0}'
    default: return 'JSON 数组，如 [1,2]'
  }
}

function numberValue(value, label, integer) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim()
  if (text === '') throw new Error(`${label} 需要填写数字`)
  const number = Number(text)
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是数字`)
  if (integer && !Number.isSafeInteger(number)) throw new Error(`${label} 必须是整数`)
  return number
}

function arrayValue(value, label) {
  let parsed
  try { parsed = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)) } catch { parsed = undefined }
  if (!Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 数组`)
  return parsed
}

function vectorValue(value, label) {
  let parsed
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value } catch { parsed = undefined }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须是 {"x","y","z"} 对象`)
  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(Number(parsed[axis]))) throw new Error(`${label}.${axis} 必须是数字`)
  }
  return { x: Number(parsed.x), y: Number(parsed.y), z: Number(parsed.z) }
}

export function serializeSignalParam(row, label = '参数') {
  const type = String(row?.type || '')
  if (!SIGNAL_PARAM_TYPES.includes(type)) throw new Error(`${label} 的类型未知：${type || '<空>'}`)
  const value = row?.value
  switch (type) {
    case 'Int': return { type, value: numberValue(value, label, true) }
    case 'Float': return { type, value: numberValue(value, label, false) }
    case 'String': return { type, value: value == null ? '' : String(value) }
    case 'Bool':
      if (typeof value !== 'boolean') throw new Error(`${label} 必须是布尔值`)
      return { type, value }
    case 'IntList': return { type, value: arrayValue(value, label).map((item, index) => numberValue(item, `${label}[${index}]`, true)) }
    case 'FloatList': return { type, value: arrayValue(value, label).map((item, index) => numberValue(item, `${label}[${index}]`, false)) }
    case 'StringList': return { type, value: arrayValue(value, label).map((item) => String(item)) }
    case 'BoolList': {
      const list = arrayValue(value, label)
      list.forEach((item, index) => { if (typeof item !== 'boolean') throw new Error(`${label}[${index}] 必须是布尔值`) })
      return { type, value: list }
    }
    case 'Vector3': return { type, value: vectorValue(value, label) }
    default: throw new Error(`${label} 的类型未知：${type}`)
  }
}

export function serializeSignalParams(rows) {
  if (!Array.isArray(rows)) throw new Error('信号参数必须是数组')
  return rows.map((row, index) => serializeSignalParam(row, `参数 ${index + 1}`))
}

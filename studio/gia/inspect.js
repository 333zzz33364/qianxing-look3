// Read-only GIA inspector. It walks the protobuf wire format directly instead of
// using the authoring schema, so files produced by other tools (node-graph
// exporters) can be reported on without being rejected or silently rewritten.
import protobuf from 'protobufjs'

const { Reader } = protobuf

const HEADER_BYTES = 20
const TAIL_BYTES = 4
const HEAD_TAG = 0x0326
const TAIL_TAG = 0x0679
const GUID_MIN = 0x40000000
const GUID_MAX = 0x403fffff
const KNOWN_WHICH = new Map([
  [15, 'ui-control-legacy'],
  [21, 'ui-control-group'],
  [61, 'primitive-material-group'],
  [69, 'script-mapping'],
  [70, 'ui-control-template'],
])

export function readEnvelope(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.length < HEADER_BYTES + TAIL_BYTES) throw new Error('GIA 文件过短')
  if (buffer.readUInt32BE(4) !== 1 || buffer.readUInt32BE(8) !== HEAD_TAG || buffer.readUInt32BE(12) !== 3) {
    throw new Error('不是受支持的 GIA v1 文件')
  }
  const payloadSize = buffer.readUInt32BE(16)
  if (payloadSize !== buffer.length - HEADER_BYTES - TAIL_BYTES) throw new Error('GIA payload 长度不一致')
  if (buffer.readUInt32BE(HEADER_BYTES + payloadSize) !== TAIL_TAG) throw new Error('GIA 尾标记无效')
  return { buffer, payload: buffer.subarray(HEADER_BYTES, HEADER_BYTES + payloadSize), payloadSize }
}

function walk(reader, visit) {
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const field = tag >>> 3
    const wire = tag & 7
    if (wire === 2) {
      const length = reader.uint32()
      const bytes = reader.buf.subarray(reader.pos, reader.pos + length)
      reader.pos += length
      visit(field, bytes, wire)
    } else if (wire === 0) {
      visit(field, reader.uint32(), wire)
    } else {
      reader.skipType(wire)
    }
  }
}

const readerOf = bytes => Reader.create(bytes)

function parseId(bytes) {
  const id = { class: 0, type: 0, id: 0 }
  walk(readerOf(bytes), (field, value, wire) => {
    if (wire !== 0) return
    if (field === 2) id.class = value
    else if (field === 3) id.type = value
    else if (field === 4) id.id = value
  })
  return id
}

function parseScript(bytes) {
  const script = { id: 0, name: '', filePath: '', sourceLength: 0 }
  walk(readerOf(bytes), (field, value, wire) => {
    if (field !== 1 || wire !== 2) return
    walk(readerOf(value), (innerField, innerValue, innerWire) => {
      if (innerField === 1 && innerWire === 0) script.id = innerValue
      else if (innerField === 2 && innerWire === 2) script.name = Buffer.from(innerValue).toString('utf8')
      else if (innerField === 3 && innerWire === 2) script.filePath = Buffer.from(innerValue).toString('utf8')
      else if (innerField === 5 && innerWire === 2) script.sourceLength = innerValue.length
    })
  })
  return script
}

export function parseUnit(bytes) {
  const unit = { name: '', which: 0, id: null, relatedIds: [], hasUi: false, script: null, rawSize: bytes.length, unknownFields: [] }
  walk(readerOf(bytes), (field, value, wire) => {
    if (field === 1 && wire === 2) unit.id = parseId(value)
    else if (field === 2 && wire === 2) unit.relatedIds.push(parseId(value))
    else if (field === 3 && wire === 2) unit.name = Buffer.from(value).toString('utf8')
    else if (field === 5 && wire === 0) unit.which = value
    else if (field === 19 && wire === 2) unit.hasUi = true
    else if (field === 35 && wire === 2) unit.script = parseScript(value)
    else unit.unknownFields.push(field)
  })
  return unit
}

const guidText = value => `0x${Number(value >>> 0).toString(16).toUpperCase()}`

export function inspectGia(input) {
  const { payload, payloadSize, buffer } = readEnvelope(input)
  const root = { filePath: '', modeFlag: null, gameVersion: '', unknownFields: [] }
  const units = []
  walk(readerOf(payload), (field, value, wire) => {
    if (field === 1 && wire === 2) units.push({ bag: 'graph', ...parseUnit(value) })
    else if (field === 2 && wire === 2) units.push({ bag: 'accessories', ...parseUnit(value) })
    else if (field === 3 && wire === 2) root.filePath = Buffer.from(value).toString('utf8')
    else if (field === 4 && wire === 0) root.modeFlag = value
    else if (field === 5 && wire === 2) root.gameVersion = Buffer.from(value).toString('utf8')
    else root.unknownFields.push(field)
  })

  const errors = []
  const warnings = []
  if (!/^\d+-\d+-\d+-\\.+\.gia$/iu.test(root.filePath)) {
    errors.push(`Root.filePath 不是 UID-TIME-ID-\\文件名.gia：${root.filePath || '<missing>'}`)
  }
  if (!root.gameVersion) warnings.push('Root.gameVersion 为空；真机可能按当前版本推断')
  if (!units.length) errors.push('Root 没有任何 GraphUnit')

  const seenGuids = new Map()
  const summaries = units.map(unit => {
    const guid = unit.id?.id
    const known = KNOWN_WHICH.get(Number(unit.which))
    const guidValid = Number.isFinite(guid) && guid >= GUID_MIN && guid <= GUID_MAX
    const summary = {
      bag: unit.bag,
      name: unit.name,
      which: unit.which,
      kind: known || `unknown:${unit.which}`,
      known: Boolean(known),
      class: unit.id?.class ?? null,
      type: unit.id?.type ?? null,
      guid: Number.isFinite(guid) ? guid : null,
      guidText: Number.isFinite(guid) ? guidText(guid) : null,
      guidValid,
      relatedCount: unit.relatedIds.length,
      hasUi: unit.hasUi,
      script: unit.script,
      rawSize: unit.rawSize,
      unknownFields: [...new Set(unit.unknownFields)],
    }
    if (!known) {
      warnings.push(`未知单元 which=${unit.which}「${unit.name || '<unnamed>'}」，只做结构报告，不做语义校验`)
    } else if (!guidValid && Number(unit.which) !== 61) {
      errors.push(`${known}「${unit.name || '<unnamed>'}」的 GUID ${summary.guidText || '<missing>'} 不在 0x40000000–0x403FFFFF`)
    }
    if (Number.isFinite(guid)) {
      if (seenGuids.has(guid)) errors.push(`GUID ${summary.guidText} 重复：${seenGuids.get(guid)} 与「${unit.name || '<unnamed>'}」`)
      else seenGuids.set(guid, `「${unit.name || '<unnamed>'}」`)
    }
    if (unit.script && !/\.lua$/i.test(unit.script.filePath || '')) {
      errors.push(`脚本「${unit.script.name || unit.script.filePath}」的 file_path 缺少 .lua 扩展名`)
    }
    return summary
  })

  const graphUnits = summaries.filter(unit => unit.bag === 'graph')
  const accessoryUnits = summaries.filter(unit => unit.bag === 'accessories')
  const templateCount = graphUnits.filter(unit => unit.which === 70).length
  const assetType = graphUnits.some(unit => unit.which === 21)
    ? 'server-control-template'
    : templateCount || graphUnits.some(unit => unit.which === 70) ? 'client-control-template' : 'unknown'

  return {
    ok: errors.length === 0,
    file: { bytes: buffer.length, payloadBytes: payloadSize },
    root: {
      filePath: root.filePath,
      gameVersion: root.gameVersion,
      modeFlag: root.modeFlag,
      unknownFields: [...new Set(root.unknownFields)],
    },
    assetType,
    counts: {
      graph: graphUnits.length,
      accessories: accessoryUnits.length,
      templates: templateCount,
      scripts: summaries.filter(unit => unit.script).length,
      unknown: summaries.filter(unit => !unit.known).length,
    },
    units: summaries,
    unknownWhich: [...new Set(summaries.filter(unit => !unit.known).map(unit => unit.which))],
    errors,
    warnings,
  }
}

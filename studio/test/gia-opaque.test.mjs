import test from 'node:test'
import assert from 'node:assert/strict'
import { createStudio, importGia } from '../index.js'
import { exportGia } from '../gia/codec.js'
import { inspectGia } from '../gia/inspect.js'
import { opaqueUsedGuids } from '../gia/opaque.js'

function varint(value) {
  const bytes = []
  let rest = value >>> 0
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}
const tag = (field, wire) => varint((field << 3) | wire)
const num = (field, value) => Buffer.concat([tag(field, 0), varint(value)])
const str = (field, text) => {
  const body = Buffer.from(text, 'utf8')
  return Buffer.concat([tag(field, 2), varint(body.length), body])
}
const msg = (field, body) => Buffer.concat([tag(field, 2), varint(body.length), body])
const cat = (...parts) => Buffer.concat(parts)
function envelope(body) {
  const header = Buffer.alloc(20)
  header.writeUInt32BE(body.length + 24, 0)
  header.writeUInt32BE(1, 4)
  header.writeUInt32BE(0x0326, 8)
  header.writeUInt32BE(3, 12)
  header.writeUInt32BE(body.length, 16)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(0x0679, 0)
  return cat(header, body, tail)
}

function foreignUnit({ guid = 1073746000, name = '节点图', which = 99, payload = Buffer.from('nodograph') } = {}) {
  return cat(msg(1, num(4, guid)), str(3, name), num(5, which), msg(30, payload))
}

function uiTemplatePayload() {
  const source = createStudio().exportData('gia', 'client-control-template')
  const bytes = Buffer.from(source.data, 'base64')
  return bytes.subarray(20, bytes.length - 4)
}

test('foreign units survive an import and export round-trip byte for byte', () => {
  const foreign = foreignUnit()
  const input = envelope(cat(uiTemplatePayload(), msg(1, foreign)))
  const imported = importGia(input)
  assert.equal(imported.metadata.opaqueUnits, 1)
  assert.deepEqual(imported.metadata.opaqueWhich, [99])
  assert.ok(imported.warnings.some(line => line.includes('已按原始字节保留 1 个非 UI 单元')))
  assert.equal(imported.project.meta.giaOpaque.units[0].bag, 'graph')

  const output = exportGia(imported.project).buffer
  assert.ok(output.includes(foreign), '导出的 GIA 应逐字节包含原始非 UI 单元')
  const inspected = inspectGia(output)
  assert.equal(inspected.ok, true, inspected.errors.join('\n'))
  const preserved = inspected.units.find(unit => unit.which === 99)
  assert.equal(preserved.name, '节点图')
  assert.equal(preserved.rawSize, foreign.length)
})

test('foreign accessories stay in the accessories bag', () => {
  const foreign = foreignUnit({ guid: 1073746001, name: '附属资源', which: 120 })
  const imported = importGia(envelope(cat(uiTemplatePayload(), msg(2, foreign))))
  assert.equal(imported.project.meta.giaOpaque.units[0].bag, 'accessories')
  const output = exportGia(imported.project).buffer
  assert.ok(output.includes(foreign))
  assert.equal(inspectGia(output).units.find(unit => unit.which === 120).bag, 'accessories')
})

test('unknown root fields are carried over instead of being dropped', () => {
  const marker = msg(9, Buffer.from('LOOK3-OPAQUE-ROOT-FIELD'))
  const imported = importGia(envelope(cat(uiTemplatePayload(), marker)))
  assert.equal(imported.project.meta.giaOpaque.rootFields.length, 1)
  assert.ok(imported.warnings.some(line => line.includes('1 个未知根字段')))
  const output = exportGia(imported.project).buffer
  assert.ok(output.includes(marker))
  assert.equal(inspectGia(output).ok, true)
})

test('preserved unit GUIDs are reserved so new controls cannot reuse them', () => {
  const foreign = foreignUnit({ guid: 1073741850 })
  const imported = importGia(envelope(cat(uiTemplatePayload(), msg(1, foreign))))
  assert.deepEqual([...opaqueUsedGuids(imported.project.meta.giaOpaque)], [1073741850])
  const output = exportGia(imported.project).buffer
  const inspected = inspectGia(output)
  assert.equal(inspected.ok, true, inspected.errors.join('\n'))
  assert.equal(inspected.units.filter(unit => unit.guid === 1073741850).length, 1, 'GUID 不得被 UI 控件重复占用')
})

test('a GIA without foreign units does not gain an opaque ledger', () => {
  const imported = importGia(envelope(uiTemplatePayload()))
  assert.equal(imported.project.meta.giaOpaque, undefined)
  assert.equal(imported.metadata.opaqueUnits, undefined)
})

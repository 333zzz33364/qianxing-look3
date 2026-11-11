import test from 'node:test'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import { createStudio } from '../index.js'
import { inspectGia } from '../gia/inspect.js'

const SCHEMA = String.raw`
syntax = "proto3";
message Root { repeated Unit graph = 1; repeated Unit accessories = 2; string filePath = 3; uint32 modeFlag = 4; string gameVersion = 5; }
message Unit {
  message Id { int32 class = 2; int32 type = 3; int32 id = 4; }
  Id id = 1; repeated Id relatedIds = 2; string name = 3; int32 which = 5; bytes ui = 19;
}
`
const { root } = protobuf.parse(SCHEMA)
const RootType = root.lookupType('Root')

function envelope(payload) {
  const header = Buffer.alloc(20)
  header.writeUInt32BE(20 + payload.length + 4 - 4, 0)
  header.writeUInt32BE(1, 4)
  header.writeUInt32BE(0x0326, 8)
  header.writeUInt32BE(3, 12)
  header.writeUInt32BE(payload.length, 16)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(0x0679, 0)
  return Buffer.concat([header, payload, tail])
}

function gia(object) {
  return envelope(Buffer.from(RootType.encode(RootType.create(object)).finish()))
}

test('a look3 generated UI GIA passes the structural report', () => {
  const studio = createStudio()
  const exported = studio.exportData('gia', 'server-control-template')
  const report = inspectGia(Buffer.from(exported.data, 'base64'))
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  assert.equal(report.assetType, 'server-control-template')
  assert.ok(report.counts.graph >= 1)
  assert.equal(report.counts.unknown, 0)
  assert.match(report.root.filePath, /^\d+-\d+-\d+-\\/u)
  assert.ok(report.units.every(unit => unit.guidValid))
})

test('unknown units are reported instead of making the file invalid', () => {
  const report = inspectGia(gia({
    filePath: '1073741824-20260101000000-1073741825-\\节点图.gia',
    gameVersion: '6.0',
    graph: [
      { id: { class: 30, type: 1, id: 1073741825 }, name: '节点图资产', which: 99 },
      { id: { class: 30, type: 1, id: 1073741900 }, name: '控件组', which: 21 },
    ],
  }))
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  assert.deepEqual(report.unknownWhich, [99])
  assert.equal(report.counts.unknown, 1)
  assert.equal(report.units[0].kind, 'unknown:99')
  assert.equal(report.units[0].known, false)
  assert.ok(report.warnings.some(text => text.includes('未知单元 which=99')))
})

test('GUID range, duplicates and filePath naming are reported as errors', () => {
  const badGuid = inspectGia(gia({
    filePath: '1073741824-20260101000000-1073741825-\\模板.gia',
    gameVersion: '6.0',
    graph: [{ id: { class: 30, type: 1, id: 19001 }, name: '旧号段模板', which: 70 }],
  }))
  assert.equal(badGuid.ok, false)
  assert.ok(badGuid.errors.some(text => text.includes('不在 0x40000000–0x403FFFFF')))

  const duplicate = inspectGia(gia({
    filePath: '1073741824-20260101000000-1073741825-\\模板.gia',
    gameVersion: '6.0',
    graph: [
      { id: { class: 30, type: 1, id: 1073742000 }, name: '模板甲', which: 70 },
      { id: { class: 30, type: 1, id: 1073742000 }, name: '模板乙', which: 70 },
    ],
  }))
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.errors.some(text => text.includes('重复')))

  const badPath = inspectGia(gia({
    filePath: 'template.gia',
    gameVersion: '6.0',
    graph: [{ id: { class: 30, type: 1, id: 1073742001 }, name: '模板', which: 70 }],
  }))
  assert.equal(badPath.ok, false)
  assert.ok(badPath.errors.some(text => text.includes('Root.filePath')))
})

test('a missing gameVersion is a warning and a broken envelope throws', () => {
  const report = inspectGia(gia({
    filePath: '1073741824-20260101000000-1073741825-\\模板.gia',
    graph: [{ id: { class: 30, type: 1, id: 1073742002 }, name: '模板', which: 70 }],
  }))
  assert.equal(report.ok, true, JSON.stringify(report.errors))
  assert.ok(report.warnings.some(text => text.includes('gameVersion')))
  assert.throws(() => inspectGia(Buffer.alloc(8)), /GIA 文件过短/)
  const valid = gia({ filePath: '1073741824-1-2-\\a.gia', gameVersion: '6.0', graph: [] })
  const corrupted = Buffer.from(valid)
  corrupted.writeUInt32BE(9, 12)
  assert.throws(() => inspectGia(corrupted), /不是受支持的 GIA v1 文件/)
})
